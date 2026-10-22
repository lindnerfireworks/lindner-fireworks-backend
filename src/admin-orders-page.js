"use strict";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function euro(value) {
  const amount = Number(value || 0);
  return (Number.isFinite(amount) ? amount : 0).toFixed(2).replace(".", ",") + " €";
}

function fulfilmentEvidence(order) {
  return order.partiallyFulfilled === true || order.fulfilled === true || order.pickedUp === true
    || Boolean(order.partiallyFulfilledAt || order.fulfilledAt || order.pickupCompletedAt)
    || Boolean(order.fulfillmentStatus && !["unfulfilled", "reserved", "pending"].includes(order.fulfillmentStatus))
    || (order.items || []).some(item => [item.fulfilledQty, item.pickedUpQty, item.soldQty].some(quantity => Number(quantity) > 0));
}

function orderState(order) {
  const status = order.status || "reserved";
  if (status === "cancelled" || order.cancelledAt) return { label: "Storniert", packable: false, className: "cancelled" };
  if (["collected", "picked_up"].includes(status) || order.pickedUp === true || order.pickupCompletedAt) return { label: "Abgeholt", packable: false, className: "closed" };
  if (status === "purchased" || order.purchaseCompletedAt) return { label: "Gekauft", packable: false, className: "closed" };
  if (order.partiallyFulfilled === true || order.partiallyFulfilledAt) return { label: "Teilweise abgeholt", packable: false, className: "closed" };
  if (["fulfilled", "completed"].includes(status) || fulfilmentEvidence(order)) return { label: "Abgeschlossen / bereits übergeben", packable: false, className: "closed" };
  if (order.stockRelease) return { label: "Freigegeben", packable: false, className: "cancelled" };
  return { label: status === "reserved" ? "Reserviert" : `Status: ${status}`, packable: true, className: "reserved" };
}

function packingTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("de-AT", { timeZone: "Europe/Vienna" });
}

// Static client source: no customer data or server credential is embedded here.
function packingClient() {
  const rows = document.querySelectorAll(".order");
  const formatTime = value => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("de-AT", { timeZone: "Europe/Vienna" });
  };
  const validState = (data, id) => data && data.id === id && typeof data.packed === "boolean"
    && Number.isSafeInteger(data.packingVersion) && data.packingVersion >= 0;

  rows.forEach(row => {
    const input = row.querySelector(".packed-input");
    const details = row.querySelector("details");
    const feedback = row.querySelector(".packing-feedback");
    const packedAt = row.querySelector(".packed-at");
    const changedAt = row.querySelector(".packing-updated-at");
    const announce = (message, state) => {
      feedback.textContent = message;
      feedback.dataset.state = state;
    };
    const applyState = data => {
      input.checked = data.packed;
      input.dataset.confirmedPacked = String(data.packed);
      input.dataset.version = String(data.packingVersion);
      packedAt.textContent = formatTime(data.packedAt);
      changedAt.textContent = formatTime(data.packingUpdatedAt);
    };

    input.disabled = input.dataset.packable !== "true";

    input.addEventListener("change", async () => {
      const previous = input.dataset.confirmedPacked === "true";
      const desired = input.checked;
      const restoreFocus = document.activeElement === input;
      input.checked = previous;
      if (row.dataset.saving === "true" || input.dataset.packable !== "true") return;
      row.dataset.saving = "true";
      input.disabled = true;
      details.inert = true;
      details.setAttribute("aria-busy", "true");
      announce("Wird gespeichert …", "saving");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch("/api/admin/order-packed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
          body: JSON.stringify({ id: input.dataset.orderId, packed: desired, expectedVersion: Number(input.dataset.version) }),
        });
        const data = await response.json();
        if (response.ok && data.ok === true && validState(data, input.dataset.orderId)) {
          applyState(data);
          announce(data.packed ? "Gepackt · gespeichert" : "Nicht gepackt · gespeichert", "saved");
        } else if (response.status === 409 && data.error === "packing_conflict" && validState(data, input.dataset.orderId)) {
          applyState(data);
          announce("Zwischenzeitlich geändert. Serverstand übernommen; bitte prüfen.", "error");
        } else if (response.status === 409 && data.error === "order_not_packable") {
          if (validState(data, input.dataset.orderId)) applyState(data);
          input.dataset.packable = "false";
          announce("Reservierung inzwischen abgeschlossen oder storniert. Bitte neu laden.", "error");
        } else {
          input.checked = previous;
          announce(response.status === 401 || response.status === 403
            ? "Nicht gespeichert. Bitte erneut anmelden."
            : "Speicherung nicht bestätigt. Zuletzt bestätigter Stand angezeigt; bitte neu laden.", "error");
        }
      } catch {
        input.checked = previous;
        announce("Speicherung nicht bestätigt. Zuletzt bestätigter Stand angezeigt; bitte neu laden.", "error");
      } finally {
        clearTimeout(timeout);
        row.dataset.saving = "false";
        details.inert = false;
        details.removeAttribute("aria-busy");
        input.disabled = input.dataset.packable !== "true";
        if (restoreFocus && !input.disabled && document.activeElement === document.body) input.focus({ preventScroll: true });
      }
    });
  });
}

function renderOrdersPage(groups, { total, umsatz, filterTag }) {
  const heute = new Date().toLocaleDateString("de-AT", { timeZone: "Europe/Vienna" });
  let index = 0;
  const gruppenHtml = groups.map(group => {
    const ordersHtml = group.orders.map(order => {
      const state = orderState(order);
      const id = `packed-${index++}`;
      const version = Number.isSafeInteger(order.packingVersion) && order.packingVersion >= 0 ? order.packingVersion : 0;
      const packed = order.packed === true;
      const packable = state.packable && Boolean(order.id);
      const articles = (order.items || []).map(item => `${esc(item.name)} <b>×${esc(item.qty)}</b>`).join("<br>");
      const phone = order.customerPhone
        ? `<a href="tel:${esc(String(order.customerPhone).replace(/\s/g, ""))}">${esc(order.customerPhone)}</a>`
        : '<span class="muted">keine Nummer</span>';
      const feedback = !packable ? `${state.label} · gesperrt` : packed ? "Gepackt" : "Noch nicht gepackt";
      return `<article class="order ${state.className}">
        <details class="order-details">
          <summary><span class="name">${esc(order.customerName || "Ohne Namen")}</span><span class="chevron" aria-hidden="true">›</span></summary>
          <div class="order-content">
            <div class="order-head"><span class="resnr">${esc(order.reservationNumber || "—")}</span><span class="sum">${euro(order.total)}</span></div>
            <p class="reservation-status">Reservierungsstatus: <strong>${esc(state.label)}</strong></p>
            <p class="pickup"><strong>Abholtermin:</strong> ${esc(order.abholtermin || "Termin noch offen")}</p>
            <div class="contact">${phone} · <a href="mailto:${esc(order.customerEmail)}">${esc(order.customerEmail)}</a></div>
            <div class="items">${articles || '<span class="muted">keine Artikel</span>'}</div>
            <div class="packing-times"><span>Gepackt am: <span class="packed-at">${esc(packingTime(order.packedAt))}</span></span><span>Packstatus geändert: <span class="packing-updated-at">${esc(packingTime(order.packingUpdatedAt))}</span></span></div>
          </div>
        </details>
        <div class="packing-control">
          <label class="packing-label" for="${id}"><input type="checkbox" id="${id}" class="packed-input" data-order-id="${esc(order.id)}" data-confirmed-packed="${packed}" data-version="${version}" data-packable="${packable}" aria-label="Ware gepackt für ${esc(order.customerName || "Ohne Namen")}" aria-describedby="${id}-feedback"${packed ? " checked" : ""} disabled><span>Ware gepackt</span></label>
        </div>
        <p class="packing-feedback" id="${id}-feedback" role="status" aria-live="polite" aria-atomic="true">${esc(feedback)}</p>
      </article>`;
    }).join("");
    const sum = group.orders.reduce((amount, order) => amount + Number(order.total || 0), 0);
    return `<section class="day"><h2>${esc(group.label)}</h2><p class="daymeta">${group.orders.length} ${group.orders.length === 1 ? "Reservierung" : "Reservierungen"} · ${euro(sum)}</p>${ordersHtml}</section>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Reservierungen — Feuerwerk Lindner</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; padding:16px; background:#28418c; color:#eef1fb; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:16px; }
  h1 { font-size:21px; margin:0 0 2px; }
  .meta { color:#cdd3f2; font-size:14px; margin-bottom:20px; overflow-wrap:anywhere; }
  .day { margin-bottom:26px; }
  .day h2 { font-size:17px; margin:0 0 2px; color:#72f2bf; overflow-wrap:anywhere; }
  .daymeta { margin:0 0 10px; font-size:13px; color:#cdd3f2; }
  .order { position:relative; background:#3655a6; border:1px solid rgba(255,255,255,0.16); border-radius:12px; margin-bottom:9px; min-width:0; }
  summary { list-style:none; cursor:pointer; min-height:64px; padding:14px 140px 14px 15px; display:flex; align-items:center; gap:8px; touch-action:manipulation; }
  summary::-webkit-details-marker { display:none; }
  .name { font-size:18px; font-weight:600; min-width:0; overflow-wrap:anywhere; }
  .chevron { font-size:26px; line-height:1; flex:0 0 auto; color:#6adfff; }
  details[open] .chevron { transform:rotate(90deg); }
  summary:focus-visible, input:focus-visible, a:focus-visible { outline:3px solid #6adfff; outline-offset:3px; border-radius:4px; }
  .order-content { padding:0 15px 15px; overflow-wrap:anywhere; }
  .order-head { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:10px; }
  .resnr { font-size:12px; letter-spacing:1px; color:#ffd23d; font-weight:700; }
  .sum { font-weight:700; color:#ff6fc4; }
  .reservation-status, .pickup { margin:10px 0; font-size:14px; line-height:1.5; }
  .cancelled .reservation-status { color:#ffd23d; }
  .contact { font-size:14px; margin-bottom:8px; line-height:1.6; }
  .items { font-size:14px; line-height:1.6; color:#cdd3f2; border-top:1px solid rgba(255,255,255,0.13); padding-top:8px; }
  .packing-control { position:absolute; top:10px; right:12px; width:112px; }
  .packing-label { display:flex; align-items:center; gap:8px; min-height:44px; font-size:13px; font-weight:600; cursor:pointer; touch-action:manipulation; }
  .packed-input { margin:0; width:20px; height:20px; flex:0 0 auto; accent-color:#72f2bf; }
  .packing-label:has(input:disabled) { cursor:default; }
  .packing-feedback { font-size:12px; line-height:1.5; color:#cdd3f2; margin:0; padding:0 15px 12px; overflow-wrap:anywhere; }
  .packing-feedback[data-state="saving"] { color:#ffd23d; }
  .packing-feedback[data-state="saved"] { color:#72f2bf; }
  .packing-feedback[data-state="error"] { color:#ffd23d; }
  .order[data-saving="true"] summary { cursor:wait; }
  .packing-times { display:flex; flex-wrap:wrap; gap:5px 18px; font-size:12px; line-height:1.6; color:#cdd3f2; margin-top:10px; }
  .muted { color:#cdd3f2; }
  a { color:#6adfff; }
  .empty { background:#3655a6; border-radius:12px; padding:22px; text-align:center; color:#cdd3f2; }
  @media (max-width:360px) { body { padding:12px; } summary { padding-left:12px; padding-right:132px; } .packing-control { right:9px; } .order-content { padding-left:12px; padding-right:12px; } }
</style>
</head>
<body>
<main>
  <h1>Reservierungen</h1>
  <form method="post" action="/api/admin/logout"><button type="submit">Abmelden</button></form>
  <p class="meta">Stand ${esc(heute)} · ${esc(total)} ${total === 1 ? "Reservierung" : "Reservierungen"} · ${euro(umsatz)} gesamt${filterTag ? `<br>Gefiltert auf ${esc(filterTag)}` : ""}</p>
  ${gruppenHtml || '<div class="empty">Noch keine Reservierungen.</div>'}
</main>
<script>(${packingClient.toString()})();</script>
</body>
</html>`;
}

module.exports = { renderOrdersPage };
