(() => {
  "use strict";

  const HABITS = [
    { key: "reading_completed", label: "Reading", short: "Reading" },
    { key: "prof_dev_completed", label: "Professional development", short: "Professional development" },
    { key: "healthy_eating_completed", label: "Healthy eating", short: "Healthy eating" },
    { key: "family_time_completed", label: "Family time", short: "Family time" },
    { key: "bed_on_time_completed", label: "Bed on time", short: "Bed on time" }
  ];
  const STREAKS = [
    { key: "reading", label: "Reading", icon: "book-open" },
    { key: "prof_dev", label: "Professional development", icon: "code-xml" },
    { key: "healthy_eating", label: "Healthy eating", icon: "salad" },
    { key: "bed_on_time", label: "Bed on time", icon: "moon-star" }
  ];
  const TIER_COLORS = {
    OPTIMAL: "#10b981",
    SOLID: "#22d3ee",
    BASELINE: "#f59e0b",
    SUBOPTIMAL: "#f97316",
    CRITICAL: "#ef4444"
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const state = {
    selectedDate: localISODate(new Date()),
    record: null,
    history: [],
    chart: null,
    activeModal: null,
    lastFocus: null,
    apiIssues: new Set()
  };

  function localISODate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatDate(iso) {
    const date = new Date(`${iso}T12:00:00`);
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
  }

  function formatDay(iso) {
    return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${iso}T12:00:00`));
  }

  function addDays(iso, amount) {
    const date = new Date(`${iso}T12:00:00`);
    date.setDate(date.getDate() + amount);
    return localISODate(date);
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.history)) return value.history;
    if (value && Array.isArray(value.records)) return value.records;
    return [];
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
      ...options
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.detail || body.message || "";
      } catch (_) {
        try { detail = await response.text(); } catch (_) { /* response has no body */ }
      }
      const error = new Error(detail || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("application/json") ? response.json() : response;
  }

  function setIssue(key, error) {
    if (error) state.apiIssues.add(key);
    else state.apiIssues.delete(key);
    const notice = $("#api-notice");
    if (state.apiIssues.size) {
      $("#api-notice-text").textContent = `Could not load ${Array.from(state.apiIssues).join(", ")}. Some readings may be incomplete.`;
      notice.classList.add("visible");
    } else {
      notice.classList.remove("visible");
    }
  }

  function showToast(message, kind = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${kind}`;
    toast.textContent = message;
    $("#toast-region").append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
    }
  }

  function scoreColor(tier) {
    return TIER_COLORS[String(tier || "").toUpperCase()] || "#8291a1";
  }

  function setPillar(prefix, value, max) {
    const n = safeNumber(value);
    $(`#pillar-${prefix}-value`).textContent = n.toFixed(1).replace(/\.0$/, "");
    const fill = $(`#pillar-${prefix}-fill`);
    fill.style.width = `${Math.max(0, Math.min(100, (n / max) * 100))}%`;
    fill.parentElement.setAttribute("aria-valuenow", String(Math.max(0, Math.min(max, n))));
  }

  function renderDate() {
    $("#selected-date").textContent = formatDate(state.selectedDate);
    $("#selected-day-caption").textContent = state.selectedDate === localISODate(new Date()) ? "Today · local date" : "Daily reading";
    $("#checkin-subtitle").textContent = `Telemetry for ${formatDay(state.selectedDate)}.`;
  }

  function renderNoRecord() {
    state.record = null;
    $("#score-number").textContent = "—";
    $("#score-number").setAttribute("aria-label", "No score recorded");
    $("#score-ring-value").style.strokeDashoffset = getRingCircumference();
    $("#score-ring-value").style.stroke = "#647382";
    $("#tier-label").textContent = "NO CHECK-IN";
    $("#tier-badge").style.color = "#8291a1";
    $("#score-message").textContent = "A little data goes a long way.";
    $("#score-context").innerHTML = "Log your day to see how your <strong>health, growth, and routines</strong> come together.";
    $("#day-empty-state").classList.add("visible");
    setPillar("health", 0, 40);
    setPillar("dev", 0, 25);
    setPillar("lifestyle", 0, 35);
    for (const habit of HABITS) {
      const card = $(`[data-habit-card="${habit.key}"]`);
      card.classList.remove("is-done");
      $(".habit-status span:last-child", card).textContent = "Not logged";
    }
    $("#habit-summary").textContent = "5 signals / awaiting check-in";
  }

  function getRingCircumference() {
    const circle = $("#score-ring-value");
    return Number(circle.getAttribute("data-circumference")) || 408.4;
  }

  function renderRecord(record) {
    state.record = record;
    $("#day-empty-state").classList.remove("visible");
    const score = Math.max(0, Math.min(100, safeNumber(record.score_total)));
    const tier = String(record.score_tier || "CRITICAL").toUpperCase();
    const color = scoreColor(tier);
    $("#score-number").textContent = Number.isInteger(score) ? String(score) : score.toFixed(1);
    $("#score-number").setAttribute("aria-label", `Score ${score} out of 100`);
    $("#score-ring-value").style.strokeDashoffset = String(getRingCircumference() * (1 - score / 100));
    $("#score-ring-value").style.stroke = color;
    $("#tier-label").textContent = tier;
    $("#tier-badge").style.color = color;
    const descriptor = {
      OPTIMAL: "A day in good alignment.",
      SOLID: "You found a strong rhythm.",
      BASELINE: "A steady place to build from.",
      SUBOPTIMAL: "A softer day still counts.",
      CRITICAL: "Take the useful signal, leave the judgment."
    };
    $("#score-message").textContent = descriptor[tier] || "Your day, in focus.";
    $("#score-context").innerHTML = `<strong>${formatDay(state.selectedDate)}</strong><br>Health, development, and lifestyle in one view.`;
    setPillar("health", record.score_health, 40);
    setPillar("dev", record.score_dev, 25);
    setPillar("lifestyle", record.score_lifestyle, 35);
    let completed = 0;
    for (const habit of HABITS) {
      const card = $(`[data-habit-card="${habit.key}"]`);
      const isDone = safeNumber(record[habit.key]) === 1 || record[habit.key] === true;
      card.classList.toggle("is-done", isDone);
      $(".habit-status span:last-child", card).textContent = isDone ? "Complete" : "Missed";
      if (isDone) completed += 1;
    }
    $("#habit-summary").textContent = `${completed} of 5 complete / ${record.day_of_week || formatDay(state.selectedDate)}`;
  }

  async function loadDay() {
    renderDate();
    const targetDate = state.selectedDate;
    $("#score-message").textContent = "Reading your signals…";
    try {
      const record = await request(`/api/day/${encodeURIComponent(targetDate)}`);
      if (targetDate !== state.selectedDate) return;
      renderRecord(record);
      setIssue("selected day", false);
    } catch (error) {
      if (targetDate !== state.selectedDate) return;
      if (error.status === 404) {
        renderNoRecord();
        setIssue("selected day", false);
      } else {
        renderNoRecord();
        setIssue("selected day", true);
      }
    }
  }

  function renderChart(history) {
    const list = toArray(history).slice(-7);
    state.history = list;
    const canvas = $("#trend-chart");
    const empty = $("#chart-empty");
    if (!list.length) {
      empty.classList.add("visible");
      canvas.style.opacity = "0";
      if (state.chart) {
        state.chart.destroy();
        state.chart = null;
      }
      return;
    }
    empty.classList.remove("visible");
    canvas.style.opacity = "1";
    if (!window.Chart) {
      $("#history-error").textContent = "Trend visualization library did not load.";
      $("#history-error").classList.add("visible");
      return;
    }
    $("#history-error").classList.remove("visible");
    const labels = list.map(item => formatDate(item.date).replace(/^[A-Za-z]{3},?\s*/, ""));
    const scores = list.map(item => safeNumber(item.score_total));
    if (state.chart) state.chart.destroy();
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, 0, 245);
    gradient.addColorStop(0, "rgba(34, 211, 238, 0.24)");
    gradient.addColorStop(1, "rgba(34, 211, 238, 0.005)");
    state.chart = new window.Chart(context, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Total score",
          data: scores,
          borderColor: "#22d3ee",
          backgroundColor: gradient,
          fill: true,
          tension: 0.36,
          borderWidth: 2,
          pointRadius: list.length > 1 ? 3 : 4,
          pointHoverRadius: 5,
          pointBackgroundColor: "#0d131c",
          pointBorderColor: "#22d3ee",
          pointBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#121c27",
            borderColor: "#2b3c4e",
            borderWidth: 1,
            titleColor: "#aebbc6",
            bodyColor: "#e7eef4",
            titleFont: { family: "JetBrains Mono", size: 10 },
            bodyFont: { family: "JetBrains Mono", size: 11 },
            displayColors: false,
            callbacks: { label: item => ` ${item.parsed.y} / 100` }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: "#758595", maxRotation: 0, font: { family: "JetBrains Mono", size: 9 } }
          },
          y: {
            min: 0, max: 100,
            grid: { color: "rgba(130, 145, 161, 0.12)", drawTicks: false },
            border: { display: false, dash: [3, 5] },
            ticks: { stepSize: 25, padding: 9, color: "#647586", font: { family: "JetBrains Mono", size: 8 }, callback: value => value }
          }
        }
      }
    });
  }

  async function loadHistory() {
    try {
      const history = await request("/api/history?days=7");
      renderChart(history);
      setIssue("history", false);
    } catch (error) {
      $("#history-error").textContent = `Trend unavailable: ${error.message}`;
      $("#history-error").classList.add("visible");
      renderChart([]);
      setIssue("history", true);
    }
  }

  function findValue(source, candidateKeys) {
    if (!source || typeof source !== "object") return undefined;
    for (const key of candidateKeys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return undefined;
  }

  function streakRecord(raw, key) {
    if (!raw) return {};
    const variants = [key, `${key}_completed`, key.replaceAll("_", ""), key.replaceAll("_", "-")];
    for (const variant of variants) {
      if (raw[variant] !== undefined) return raw[variant];
    }
    return {};
  }

  function renderStreaks(raw) {
    const target = $("#streaks-list");
    target.replaceChildren();
    for (const habit of STREAKS) {
      const item = streakRecord(raw, habit.key);
      const current = safeNumber(findValue(item, ["current", "current_streak", "streak", "days", "current_days"]), safeNumber(findValue(raw, [`${habit.key}_current`, `${habit.key}_current_streak`]), 0));
      const best = safeNumber(findValue(item, ["record", "best", "longest", "longest_streak", "record_streak", "best_streak"]), safeNumber(findValue(raw, [`${habit.key}_record`, `${habit.key}_best`, `${habit.key}_record_streak`]), 0));
      const row = document.createElement("div");
      row.className = "streak-row";
      row.innerHTML = `<span class="streak-name"><span class="streak-icon"><i data-lucide="${habit.icon}" size="13"></i></span>${habit.label}</span><span class="streak-now">${current} <span style="color:var(--muted);font-size:8px">DAYS</span></span><span class="streak-best">best ${best}</span>`;
      target.append(row);
    }
    refreshIcons();
  }

  async function loadStreaks() {
    try {
      const data = await request("/api/streaks");
      renderStreaks(data);
      setIssue("streaks", false);
    } catch (error) {
      $("#streaks-list").innerHTML = `<div class="panel-error visible">Streaks unavailable: ${escapeHTML(error.message)}</div>`;
      setIssue("streaks", true);
    }
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function normalizeBottleneck(data) {
    const bottleneck = data && data.bottleneck && typeof data.bottleneck === "object" ? data.bottleneck : data;
    if (Array.isArray(bottleneck)) return bottleneck[0] || {};
    return bottleneck || {};
  }

  function renderBottleneck(data) {
    const item = normalizeBottleneck(data);
    const label = findValue(item, ["habit", "habit_name", "name", "lowest_habit", "bottleneck"]) || findValue(data, ["habit", "habit_name", "name"]) || "";
    const rawPercent = findValue(item, ["adherence", "adherence_pct", "percentage", "percent", "rate", "adherence_percentage"]);
    let percent = safeNumber(rawPercent, 0);
    if (percent > 0 && percent <= 1) percent *= 100;
    percent = Math.max(0, Math.min(100, percent));
    const logs = findValue(item, ["days_logged", "logged_days", "sample_size", "days", "count"]);
    $("#focus-habit").textContent = label ? String(label).replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase()) : "No bottleneck data yet";
    $("#focus-percent").textContent = rawPercent === undefined ? "—" : `${Math.round(percent)}%`;
    $("#focus-fill").style.width = rawPercent === undefined ? "0%" : `${percent}%`;
    $(".focus-track").setAttribute("aria-valuenow", String(Math.round(percent)));
    $("#focus-days").textContent = logs !== undefined ? `${logs} of 30 days observed` : "30-day adherence";
  }

  async function loadBottleneck() {
    try {
      const data = await request("/api/bottleneck");
      renderBottleneck(data);
      $("#insight-error").classList.remove("visible");
      setIssue("monthly focus", false);
    } catch (error) {
      $("#focus-habit").textContent = "Focus data unavailable";
      $("#focus-percent").textContent = "—";
      $("#insight-error").textContent = error.message;
      $("#insight-error").classList.add("visible");
      setIssue("monthly focus", true);
    }
  }

  async function loadDashboard() {
    await Promise.allSettled([loadDay(), loadHistory(), loadStreaks(), loadBottleneck()]);
  }

  function openModal(id) {
    const backdrop = $(`#${id}`);
    if (!backdrop) return;
    state.lastFocus = document.activeElement;
    state.activeModal = backdrop;
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    if (id === "checkin-modal") populateCheckin();
    const firstControl = $("[data-close-modal]", backdrop);
    if (firstControl) firstControl.focus();
  }

  function closeModal() {
    if (!state.activeModal) return;
    state.activeModal.classList.remove("open");
    state.activeModal.setAttribute("aria-hidden", "true");
    state.activeModal = null;
    document.body.style.overflow = "";
    if (state.lastFocus && typeof state.lastFocus.focus === "function") state.lastFocus.focus();
  }

  function populateCheckin() {
    const form = $("#checkin-form");
    form.reset();
    $("#checkin-feedback").textContent = "";
    $("#checkin-feedback").className = "form-feedback";
    const record = state.record;
    if (!record) return;
    for (const name of ["steps", "exercise_minutes", "sleep_hours", "resting_hr", "water_liters", "day_rating", "notes"]) {
      const field = form.elements.namedItem(name);
      if (field && record[name] !== null && record[name] !== undefined) field.value = record[name];
    }
    for (const habit of HABITS) {
      const checkbox = form.elements.namedItem(habit.key);
      checkbox.checked = safeNumber(record[habit.key]) === 1 || record[habit.key] === true;
    }
  }

  function getNumeric(form, name, decimals = false, optional = false) {
    const raw = String(form.elements.namedItem(name).value).trim();
    if (raw === "" && optional) return null;
    if (raw === "") return 0;
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0) throw new Error(`Enter a valid non-negative value for ${name.replaceAll("_", " ")}.`);
    return decimals ? number : Math.round(number);
  }

  async function submitCheckin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $("#save-checkin");
    const feedback = $("#checkin-feedback");
    button.disabled = true;
    feedback.className = "form-feedback";
    feedback.textContent = "Saving your check-in…";
    try {
      const payload = {
        date: state.selectedDate,
        steps: getNumeric(form, "steps"),
        exercise_minutes: getNumeric(form, "exercise_minutes"),
        sleep_hours: getNumeric(form, "sleep_hours", true),
        resting_hr: getNumeric(form, "resting_hr", false, true),
        water_liters: getNumeric(form, "water_liters", true),
        day_rating: form.elements.namedItem("day_rating").value === "" ? null : Number(form.elements.namedItem("day_rating").value),
        notes: form.elements.namedItem("notes").value.trim()
      };
      for (const habit of HABITS) payload[habit.key] = form.elements.namedItem(habit.key).checked ? 1 : 0;
      const saved = await request("/api/checkin", { method: "POST", body: JSON.stringify(payload) });
      state.record = saved;
      renderRecord(saved);
      feedback.className = "form-feedback success";
      feedback.textContent = "Saved. Your day is up to date.";
      showToast("Check-in saved for this day.", "success");
      await Promise.allSettled([loadHistory(), loadStreaks(), loadBottleneck()]);
      window.setTimeout(closeModal, 450);
    } catch (error) {
      feedback.className = "form-feedback error";
      feedback.textContent = error.message || "Unable to save this check-in. Try again.";
    } finally {
      button.disabled = false;
    }
  }

  function setShortcutContent() {
    const endpoint = `${window.location.origin}/api/checkin`;
    $("#webhook-url").textContent = endpoint;
    const example = {
      date: state.selectedDate,
      steps: 9450,
      exercise_minutes: 35,
      sleep_hours: 7.2,
      resting_hr: 62,
      water_liters: 2.5,
      reading_completed: 1,
      prof_dev_completed: 1,
      healthy_eating_completed: 1,
      family_time_completed: 1,
      bed_on_time_completed: 0,
      day_rating: 3,
      notes: "Evening workout complete"
    };
    $("#payload-example").textContent = JSON.stringify(example, null, 2);
  }

  async function copyText(value, button) {
    const original = button.innerHTML;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const input = document.createElement("textarea");
        input.value = value;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("Clipboard unavailable");
      }
      button.textContent = "Copied";
      showToast("Copied to clipboard.");
    } catch (_) {
      showToast("Copy is unavailable in this browser.", "error");
    }
    window.setTimeout(() => { button.innerHTML = original; refreshIcons(); }, 1500);
  }

  async function seedHistory() {
    const button = $("#seed-history");
    button.disabled = true;
    try {
      await request("/api/seed", { method: "POST", body: JSON.stringify({}) });
      showToast("History initialized from the available seed endpoint.");
      await Promise.allSettled([loadDashboard()]);
    } catch (error) {
      showToast(`Could not initialize history: ${error.message}`, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function exportCSV(event) {
    event.preventDefault();
    const link = $("#export-link");
    link.setAttribute("aria-busy", "true");
    try {
      const response = await request("/api/export/csv");
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      const filename = match ? decodeURIComponent(match[1].replace(/"/g, "")) : "cosmo-telemetry.csv";
      const objectURL = URL.createObjectURL(blob);
      const download = document.createElement("a");
      download.href = objectURL;
      download.download = filename;
      document.body.append(download);
      download.click();
      download.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
      showToast("Your telemetry export is ready.");
    } catch (error) {
      showToast(`CSV export failed: ${error.message}`, "error");
    } finally {
      link.removeAttribute("aria-busy");
    }
  }

  function changeDate(date) {
    state.selectedDate = date;
    loadDay();
  }

  function bindEvents() {
    $("#previous-day").addEventListener("click", () => changeDate(addDays(state.selectedDate, -1)));
    $("#next-day").addEventListener("click", () => changeDate(addDays(state.selectedDate, 1)));
    $("#today-button").addEventListener("click", () => changeDate(localISODate(new Date())));
    $("#checkin-open").addEventListener("click", () => openModal("checkin-modal"));
    $("#empty-checkin").addEventListener("click", () => openModal("checkin-modal"));
    $("#shortcut-open").addEventListener("click", () => { setShortcutContent(); openModal("shortcut-modal"); });
    $("#empty-shortcut").addEventListener("click", () => { setShortcutContent(); openModal("shortcut-modal"); });
    $("#checkin-form").addEventListener("submit", submitCheckin);
    $("#retry-button").addEventListener("click", loadDashboard);
    $("#seed-history").addEventListener("click", seedHistory);
    $("#copy-url").addEventListener("click", event => copyText($("#webhook-url").textContent, event.currentTarget));
    $("#export-link").addEventListener("click", exportCSV);
    $$("[data-close-modal]").forEach(button => button.addEventListener("click", closeModal));
    $$(".modal-backdrop").forEach(backdrop => backdrop.addEventListener("mousedown", event => {
      if (event.target === backdrop) closeModal();
    }));
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && state.activeModal) closeModal();
      if (event.key === "Tab" && state.activeModal) {
        const focusable = $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]', state.activeModal)
          .filter(element => element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }

  function init() {
    $("#score-ring-value").setAttribute("data-circumference", String(2 * Math.PI * 65));
    renderDate();
    bindEvents();
    refreshIcons();
    loadDashboard();
  }

  document.addEventListener("DOMContentLoaded", init, { once: true });
})();