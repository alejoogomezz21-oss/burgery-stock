// ============================================================
// BURGERY GO — Stock & Pedidos
// ============================================================
// Explicación general para que entiendas cómo está armado:
//
// 1. Nos conectamos a Firestore (la base de datos de Firebase).
// 2. Tenemos 3 "colecciones" (como tablas):
//      - insumos   -> lo que compras (pan, carne, queso, etc.)
//      - productos -> lo que vendes (ej: "Smash Clásica"), cada uno
//                     tiene una "receta": qué insumos y cuánta
//                     cantidad de cada uno usa UNA unidad de ese producto.
//      - pedidos   -> cada pedido que registras a mano cuando llega
//                     por WhatsApp. Al guardarlo, se descuenta el
//                     stock de los insumos usados, según la receta.
// 3. onSnapshot() = "escuchar en tiempo real": si tú registras algo
//    desde tu celular, tu novia lo ve actualizado en el suyo al
//    instante, sin recargar nada.
// 4. runTransaction() = usamos esto al registrar un pedido para que
//    el descuento de stock sea seguro: si dos personas registran un
//    pedido al mismo tiempo, Firestore evita que se pisen los datos.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, runTransaction, serverTimestamp, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// --- Tu configuración de Firebase (la que copiaste de la consola) ---
const firebaseConfig = {
  apiKey: "AIzaSyDPTks7TynOkQrf3PdSJNPxxrDkzrxQtqw",
  authDomain: "burgery-go.firebaseapp.com",
  projectId: "burgery-go",
  storageBucket: "burgery-go.firebasestorage.app",
  messagingSenderId: "426748114141",
  appId: "1:426748114141:web:250eb46322ffbb96e0d734"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const refInsumos   = collection(db, "insumos");
const refProductos = collection(db, "productos");
const refPedidos   = collection(db, "pedidos");

// Guardamos en memoria lo último que llegó de Firestore para no
// tener que volver a pedirlo cada vez que dibujamos algo en pantalla.
let insumosCache = [];
let productosCache = [];
let pedidosCache = [];

// ============================================================
// NAVEGACIÓN ENTRE PESTAÑAS
// ============================================================
document.querySelectorAll("nav.side button[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav.side button[data-tab]").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

function cerrarModales(){
  document.querySelectorAll(".overlay").forEach(o => o.classList.remove("abierto"));
}
document.querySelectorAll("[data-cerrar]").forEach(el => el.addEventListener("click", cerrarModales));

// ============================================================
// 1) INSUMOS (materia prima / stock)
// ============================================================
onSnapshot(refInsumos, (snap) => {
  insumosCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  insumosCache.sort((a,b) => a.nombre.localeCompare(b.nombre));
  pintarInsumos();
  actualizarSelectsDeInsumos();
  pintarDashboard();
});

function pintarInsumos(){
  const cont = document.getElementById("lista-insumos");
  if (insumosCache.length === 0){
    cont.innerHTML = `<p class="vacio">Todavía no has agregado insumos. Crea el primero con "Nuevo insumo".</p>`;
    return;
  }
  cont.innerHTML = insumosCache.map(ins => {
    const bajo = ins.stock <= ins.stockMinimo;
    const pct = ins.stockMinimo > 0 ? Math.min(100, (ins.stock / (ins.stockMinimo * 3)) * 100) : 100;
    return `
      <div class="item-insumo">
        <div>
          <div class="nombre">${ins.nombre}</div>
          <div class="barra"><div class="${bajo ? 'bajo':''}" style="width:${pct}%"></div></div>
        </div>
        <div class="cantidad ${bajo ? 'bajo':''}">${formatear(ins.stock)} ${ins.unidad}</div>
        <div>
          <button class="btn secundario" style="padding:6px 10px;font-size:12.5px" data-sumar="${ins.id}">+ Ingreso stock</button>
        </div>
        <div>
          <button class="icon-btn" data-editar-insumo="${ins.id}">✎</button>
          <button class="icon-btn" data-borrar-insumo="${ins.id}">✕</button>
        </div>
      </div>`;
  }).join("");

  cont.querySelectorAll("[data-sumar]").forEach(b =>
    b.addEventListener("click", () => abrirModalSumarStock(b.dataset.sumar)));
  cont.querySelectorAll("[data-editar-insumo]").forEach(b =>
    b.addEventListener("click", () => abrirModalInsumo(b.dataset.editarInsumo)));
  cont.querySelectorAll("[data-borrar-insumo]").forEach(b =>
    b.addEventListener("click", () => borrarInsumo(b.dataset.borrarInsumo)));
}

function formatear(n){
  return Number(n).toLocaleString("es-CO", { maximumFractionDigits: 2 });
}

// --- Modal crear/editar insumo ---
const modalInsumo = document.getElementById("modal-insumo");
let editandoInsumoId = null;

document.getElementById("btn-nuevo-insumo").addEventListener("click", () => abrirModalInsumo(null));

function abrirModalInsumo(id){
  editandoInsumoId = id;
  const form = document.getElementById("form-insumo");
  form.reset();
  document.getElementById("modal-insumo-titulo").textContent = id ? "Editar insumo" : "Nuevo insumo";
  if (id){
    const ins = insumosCache.find(i => i.id === id);
    form.nombre.value = ins.nombre;
    form.unidad.value = ins.unidad;
    form.stock.value = ins.stock;
    form.stockMinimo.value = ins.stockMinimo;
    form.costoUnidad.value = ins.costoUnidad || 0;
  }
  modalInsumo.classList.add("abierto");
}

document.getElementById("form-insumo").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const datos = {
    nombre: f.nombre.value.trim(),
    unidad: f.unidad.value,
    stock: parseFloat(f.stock.value) || 0,
    stockMinimo: parseFloat(f.stockMinimo.value) || 0,
    costoUnidad: parseFloat(f.costoUnidad.value) || 0
  };
  if (editandoInsumoId){
    await updateDoc(doc(db, "insumos", editandoInsumoId), datos);
  } else {
    await addDoc(refInsumos, datos);
  }
  cerrarModales();
});

async function borrarInsumo(id){
  if (!confirm("¿Borrar este insumo? Si algún producto lo usa en su receta, esa receta quedará incompleta.")) return;
  await deleteDoc(doc(db, "insumos", id));
}

// --- Modal "ingreso de stock" (cuando compras más insumo) ---
const modalSumar = document.getElementById("modal-sumar-stock");
let insumoASumarId = null;

function abrirModalSumarStock(id){
  insumoASumarId = id;
  const ins = insumosCache.find(i => i.id === id);
  document.getElementById("sumar-nombre-insumo").textContent = ins.nombre;
  document.getElementById("form-sumar-stock").reset();
  modalSumar.classList.add("abierto");
}

document.getElementById("form-sumar-stock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cantidad = parseFloat(e.target.cantidad.value) || 0;
  const ins = insumosCache.find(i => i.id === insumoASumarId);
  await updateDoc(doc(db, "insumos", insumoASumarId), { stock: ins.stock + cantidad });
  cerrarModales();
});

// ============================================================
// 2) PRODUCTOS + RECETA
// ============================================================
onSnapshot(refProductos, (snap) => {
  productosCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  productosCache.sort((a,b) => a.nombre.localeCompare(b.nombre));
  pintarProductos();
  actualizarSelectDeProductosEnPedido();
});

// Suma cuánto cuesta hacer 1 unidad de un producto, según su receta
// y el costoUnidad de cada insumo (lo que tú pagaste por comprarlo).
function costoReceta(producto){
  return (producto.receta || []).reduce((acc, r) => {
    const ins = insumosCache.find(i => i.id === r.insumoId);
    return acc + r.cantidad * (ins?.costoUnidad || 0);
  }, 0);
}

function pintarProductos(){
  const cont = document.getElementById("lista-productos");
  if (productosCache.length === 0){
    cont.innerHTML = `<p class="vacio">Todavía no has creado productos. Crea el primero con "Nuevo producto".</p>`;
    return;
  }
  cont.innerHTML = productosCache.map(p => {
    const receta = (p.receta || []).map(r => {
      const ins = insumosCache.find(i => i.id === r.insumoId);
      return `${ins ? ins.nombre : "(insumo borrado)"}: ${formatear(r.cantidad)} ${ins ? ins.unidad : ""}`;
    }).join(" · ") || "sin receta";
    const costo = costoReceta(p);
    const ganancia = p.precio - costo;
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div>
            <div class="nombre" style="font-weight:600">${p.nombre} — $${formatear(p.precio)}</div>
            <div style="color:var(--text-dim);font-size:12.5px;margin-top:4px">${receta}</div>
            <div style="margin-top:6px;font-size:12.5px">
              Costo: <strong>$${formatear(costo)}</strong> ·
              Ganancia por unidad: <strong style="color:var(--mostaza)">$${formatear(ganancia)}</strong>
            </div>
          </div>
          <div>
            <button class="icon-btn" data-editar-producto="${p.id}">✎</button>
            <button class="icon-btn" data-borrar-producto="${p.id}">✕</button>
          </div>
        </div>
      </div>`;
  }).join("");

  cont.querySelectorAll("[data-editar-producto]").forEach(b =>
    b.addEventListener("click", () => abrirModalProducto(b.dataset.editarProducto)));
  cont.querySelectorAll("[data-borrar-producto]").forEach(b =>
    b.addEventListener("click", () => borrarProducto(b.dataset.borrarProducto)));
}

const modalProducto = document.getElementById("modal-producto");
let editandoProductoId = null;

document.getElementById("btn-nuevo-producto").addEventListener("click", () => abrirModalProducto(null));

function abrirModalProducto(id){
  editandoProductoId = id;
  document.getElementById("form-producto").reset();
  document.getElementById("filas-receta").innerHTML = "";
  document.getElementById("modal-producto-titulo").textContent = id ? "Editar producto" : "Nuevo producto";

  if (id){
    const p = productosCache.find(x => x.id === id);
    document.getElementById("form-producto").nombre.value = p.nombre;
    document.getElementById("form-producto").precio.value = p.precio;
    (p.receta || []).forEach(r => agregarFilaReceta(r.insumoId, r.cantidad));
  }
  if ((document.getElementById("filas-receta").children.length) === 0) agregarFilaReceta();
  modalProducto.classList.add("abierto");
}

document.getElementById("btn-agregar-ingrediente").addEventListener("click", () => agregarFilaReceta());

function agregarFilaReceta(insumoIdSel = "", cantidadSel = ""){
  const fila = document.createElement("div");
  fila.className = "fila-receta";
  fila.innerHTML = `
    <div>
      <label>Insumo</label>
      <select class="receta-insumo">
        ${insumosCache.map(i => `<option value="${i.id}" ${i.id===insumoIdSel?"selected":""}>${i.nombre}</option>`).join("")}
      </select>
    </div>
    <div>
      <label>Cantidad</label>
      <input type="number" step="0.01" class="receta-cantidad" value="${cantidadSel}" placeholder="ej: 150">
    </div>
    <button type="button" class="icon-btn" data-quitar-fila>✕</button>
  `;
  fila.querySelector("[data-quitar-fila]").addEventListener("click", () => fila.remove());
  document.getElementById("filas-receta").appendChild(fila);
}

function actualizarSelectsDeInsumos(){
  // Refresca las opciones de insumo en filas de receta ya abiertas
  document.querySelectorAll(".receta-insumo").forEach(sel => {
    const actual = sel.value;
    sel.innerHTML = insumosCache.map(i => `<option value="${i.id}" ${i.id===actual?"selected":""}>${i.nombre}</option>`).join("");
  });
}

document.getElementById("form-producto").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const receta = [...document.querySelectorAll("#filas-receta .fila-receta")].map(fila => ({
    insumoId: fila.querySelector(".receta-insumo").value,
    cantidad: parseFloat(fila.querySelector(".receta-cantidad").value) || 0
  })).filter(r => r.insumoId && r.cantidad > 0);

  const datos = {
    nombre: f.nombre.value.trim(),
    precio: parseFloat(f.precio.value) || 0,
    receta
  };
  if (editandoProductoId){
    await updateDoc(doc(db, "productos", editandoProductoId), datos);
  } else {
    await addDoc(refProductos, datos);
  }
  cerrarModales();
});

async function borrarProducto(id){
  if (!confirm("¿Borrar este producto?")) return;
  await deleteDoc(doc(db, "productos", id));
}

// ============================================================
// 3) PEDIDOS  (acá se descuenta el stock automáticamente)
// ============================================================
const q_pedidos = query(refPedidos, orderBy("fecha", "desc"), limit(1000));
onSnapshot(q_pedidos, (snap) => {
  pedidosCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  pintarPedidos();
  pintarDashboard();
  pintarHistorial();
});

// Agrupa todos los pedidos por día calendario y suma pedidos, vendido,
// costo y ganancia de cada día — así queda tu historial de negocio.
function pintarHistorial(){
  const cont = document.getElementById("lista-historial");
  const conFecha = pedidosCache.filter(p => p.fecha?.toDate);
  if (conFecha.length === 0){
    cont.innerHTML = `<p class="vacio">Todavía no hay pedidos para mostrar historial.</p>`;
    return;
  }

  const porDia = {}; // "2026-09-15" -> { etiqueta, pedidos, vendido, costo, ganancia }
  conFecha.forEach(p => {
    const f = p.fecha.toDate();
    const clave = f.toISOString().slice(0,10);
    if (!porDia[clave]){
      porDia[clave] = {
        etiqueta: f.toLocaleDateString("es-CO", { weekday:'long', day:'numeric', month:'long' }),
        pedidos: 0, vendido: 0, costo: 0, ganancia: 0
      };
    }
    porDia[clave].pedidos += 1;
    porDia[clave].vendido += p.total || 0;
    porDia[clave].costo += p.costoTotal || 0;
    porDia[clave].ganancia += p.gananciaTotal || 0;
  });

  const claves = Object.keys(porDia).sort((a,b) => b.localeCompare(a)); // más reciente primero

  cont.innerHTML = `
    <table>
      <thead><tr><th>Fecha</th><th>Pedidos</th><th>Vendido</th><th>Costo</th><th>Ganancia</th></tr></thead>
      <tbody>
        ${claves.map(k => {
          const d = porDia[k];
          return `<tr>
            <td style="text-transform:capitalize">${d.etiqueta}</td>
            <td>${d.pedidos}</td>
            <td>$${formatear(d.vendido)}</td>
            <td>$${formatear(d.costo)}</td>
            <td style="color:var(--mostaza);font-weight:600">$${formatear(d.ganancia)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

function pintarPedidos(){
  const cont = document.getElementById("lista-pedidos");
  if (pedidosCache.length === 0){
    cont.innerHTML = `<p class="vacio">Todavía no hay pedidos registrados.</p>`;
    return;
  }
  cont.innerHTML = `
    <table>
      <thead><tr><th>Fecha</th><th>Items</th><th>Total</th></tr></thead>
      <tbody>
        ${pedidosCache.map(p => `
          <tr>
            <td>${p.fecha?.toDate ? p.fecha.toDate().toLocaleString("es-CO",{dateStyle:'short',timeStyle:'short'}) : "..."}</td>
            <td>${(p.items||[]).map(it => `${it.cantidad}× ${it.nombre}`).join(", ")}</td>
            <td>$${formatear(p.total)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>`;
}

// --- Modal nuevo pedido ---
const modalPedido = document.getElementById("modal-pedido");
document.getElementById("btn-nuevo-pedido").addEventListener("click", abrirModalPedido);

function abrirModalPedido(){
  document.getElementById("filas-pedido").innerHTML = "";
  document.getElementById("aviso-pedido").style.display = "none";
  agregarFilaPedido();
  recalcularTotalPedido();
  modalPedido.classList.add("abierto");
}

document.getElementById("btn-agregar-item-pedido").addEventListener("click", () => agregarFilaPedido());

function agregarFilaPedido(){
  const fila = document.createElement("div");
  fila.className = "linea-item-pedido";
  fila.innerHTML = `
    <select class="pedido-producto">
      ${productosCache.map(p => `<option value="${p.id}">${p.nombre}</option>`).join("")}
    </select>
    <input type="number" min="1" value="1" class="pedido-cantidad">
    <div class="pedido-subtotal">$0</div>
    <button type="button" class="icon-btn" data-quitar-item>✕</button>
  `;
  fila.querySelector(".pedido-producto").addEventListener("change", recalcularTotalPedido);
  fila.querySelector(".pedido-cantidad").addEventListener("input", recalcularTotalPedido);
  fila.querySelector("[data-quitar-item]").addEventListener("click", () => { fila.remove(); recalcularTotalPedido(); });
  document.getElementById("filas-pedido").appendChild(fila);
  recalcularTotalPedido();
}

function actualizarSelectDeProductosEnPedido(){
  document.querySelectorAll(".pedido-producto").forEach(sel => {
    const actual = sel.value;
    sel.innerHTML = productosCache.map(p => `<option value="${p.id}" ${p.id===actual?"selected":""}>${p.nombre}</option>`).join("");
  });
}

function leerLineasPedido(){
  return [...document.querySelectorAll("#filas-pedido .linea-item-pedido")].map(fila => {
    const productoId = fila.querySelector(".pedido-producto").value;
    const cantidad = parseInt(fila.querySelector(".pedido-cantidad").value) || 0;
    const producto = productosCache.find(p => p.id === productoId);
    return { fila, productoId, cantidad, producto };
  }).filter(l => l.producto && l.cantidad > 0);
}

function recalcularTotalPedido(){
  let total = 0;
  leerLineasPedido().forEach(l => {
    const subtotal = l.producto.precio * l.cantidad;
    total += subtotal;
    l.fila.querySelector(".pedido-subtotal").textContent = "$" + formatear(subtotal);
  });
  document.getElementById("total-pedido").textContent = "$" + formatear(total);
}

document.getElementById("form-pedido").addEventListener("submit", async (e) => {
  e.preventDefault();
  const lineas = leerLineasPedido();
  const avisoEl = document.getElementById("aviso-pedido");
  avisoEl.style.display = "none";

  if (lineas.length === 0) return;

  try {
    // runTransaction: lee el stock actual, verifica que alcance, y
    // descuenta TODO junto. Si algo falla a mitad de camino, no se
    // guarda nada a medias — o se aplica todo, o no se aplica nada.
    await runTransaction(db, async (tx) => {
      // 1) Calculamos cuánto de cada insumo se necesita en total
      const necesidad = {}; // insumoId -> cantidad total requerida
      for (const l of lineas){
        for (const r of (l.producto.receta || [])){
          necesidad[r.insumoId] = (necesidad[r.insumoId] || 0) + r.cantidad * l.cantidad;
        }
      }

      // 2) Leemos el stock real de cada insumo involucrado dentro de la transacción
      const insumoRefs = {};
      const insumoDocs = {};
      for (const insumoId of Object.keys(necesidad)){
        const ref = doc(db, "insumos", insumoId);
        insumoRefs[insumoId] = ref;
        insumoDocs[insumoId] = await tx.get(ref);
      }

      // 3) Verificamos que haya stock suficiente de TODOS antes de tocar nada
      const faltantes = [];
      for (const insumoId of Object.keys(necesidad)){
        const actual = insumoDocs[insumoId].data()?.stock ?? 0;
        if (actual < necesidad[insumoId]){
          const nombre = insumosCache.find(i => i.id === insumoId)?.nombre || insumoId;
          faltantes.push(`${nombre} (necesitas ${formatear(necesidad[insumoId])}, hay ${formatear(actual)})`);
        }
      }
      if (faltantes.length > 0){
        throw new Error("STOCK_INSUFICIENTE: " + faltantes.join(" · "));
      }

      // 4) Descontamos el stock
      for (const insumoId of Object.keys(necesidad)){
        const actual = insumoDocs[insumoId].data().stock;
        tx.update(insumoRefs[insumoId], { stock: actual - necesidad[insumoId] });
      }

      // 5) Calculamos costo y ganancia REAL de este pedido, usando el
      // costoUnidad de cada insumo tal como estaba justo en este momento
      // (así, si el precio de un insumo sube en el futuro, no se altera
      // la ganancia ya registrada de pedidos pasados).
      const items = lineas.map(l => {
        const costoUnit = (l.producto.receta || []).reduce((acc, r) => {
          const costoInsumo = insumoDocs[r.insumoId]?.data()?.costoUnidad || 0;
          return acc + r.cantidad * costoInsumo;
        }, 0);
        const gananciaUnit = l.producto.precio - costoUnit;
        return {
          productoId: l.productoId,
          nombre: l.producto.nombre,
          cantidad: l.cantidad,
          precioUnit: l.producto.precio,
          costoUnit,
          gananciaUnit
        };
      });

      const total = items.reduce((acc, it) => acc + it.precioUnit * it.cantidad, 0);
      const costoTotal = items.reduce((acc, it) => acc + it.costoUnit * it.cantidad, 0);
      const gananciaTotal = items.reduce((acc, it) => acc + it.gananciaUnit * it.cantidad, 0);

      // 6) Guardamos el pedido
      tx.set(doc(refPedidos), { fecha: serverTimestamp(), items, total, costoTotal, gananciaTotal });
    });

    cerrarModales();
  } catch (err) {
    if (String(err.message).startsWith("STOCK_INSUFICIENTE")){
      avisoEl.textContent = "No hay stock suficiente: " + err.message.replace("STOCK_INSUFICIENTE: ", "");
      avisoEl.style.display = "block";
    } else {
      console.error(err);
      avisoEl.textContent = "Ocurrió un error guardando el pedido. Intenta de nuevo.";
      avisoEl.style.display = "block";
    }
  }
});

// ============================================================
// 4) DASHBOARD
// ============================================================
function pintarDashboard(){
  const bajos = insumosCache.filter(i => i.stock <= i.stockMinimo);
  document.getElementById("stat-insumos-bajos").textContent = bajos.length;

  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const pedidosHoy = pedidosCache.filter(p => p.fecha?.toDate && p.fecha.toDate() >= hoy);
  document.getElementById("stat-pedidos-hoy").textContent = pedidosHoy.length;
  document.getElementById("stat-ventas-hoy").textContent = "$" + formatear(pedidosHoy.reduce((a,p) => a + p.total, 0));
  document.getElementById("stat-ganancias-hoy").textContent = "$" + formatear(pedidosHoy.reduce((a,p) => a + (p.gananciaTotal || 0), 0));

  const cont = document.getElementById("dashboard-alertas");
  cont.innerHTML = bajos.length === 0
    ? `<p class="vacio">Todo el stock está en niveles saludables.</p>`
    : bajos.map(i => `<div class="item-insumo" style="grid-template-columns:1fr auto">
         <div class="nombre">${i.nombre}</div>
         <div><span class="badge bajo">Bajo: ${formatear(i.stock)} ${i.unidad}</span></div>
       </div>`).join("");
}
