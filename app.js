(() => {
  'use strict';

  const STORAGE_KEY = 'suiviTrail.data.v1';
  const AUTO_BACKUP_KEY = 'suiviTrail.autoBackup.v1';
  const REMINDER_CHECK_MS = 60 * 1000;

  /** @type {{plans: Array<Object>, results: Array<Object>}} */
  let data = loadData();

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('Lecture données corrompue, réinitialisation.', e);
    }
    return { plans: [], results: [] };
  }

  function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    maybeAutoBackup();
  }

  function downloadBackup(filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getAutoBackupSettings() {
    try {
      const raw = localStorage.getItem(AUTO_BACKUP_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore corrupted settings */ }
    return { enabled: false, lastDate: null };
  }

  function setAutoBackupSettings(settings) {
    localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(settings));
  }

  // Downloads a real file into "Téléchargements" once per day, independent of browser storage.
  // Fixed filename: browsers refuse to silently overwrite existing files for security reasons,
  // so Android will still add "(1)", "(2)"... to repeat downloads of the same name.
  function maybeAutoBackup() {
    const settings = getAutoBackupSettings();
    if (!settings.enabled) return;
    const today = new Date().toISOString().slice(0, 10);
    if (settings.lastDate === today) return;
    downloadBackup('suivi-trail-backup.json');
    settings.lastDate = today;
    setAutoBackupSettings(settings);
    updateAutoBackupStatus();
  }

  function updateAutoBackupStatus() {
    const settings = getAutoBackupSettings();
    const status = document.getElementById('auto-backup-status');
    if (!status) return;
    status.textContent = settings.lastDate
      ? `Dernière sauvegarde automatique : ${formatDate(settings.lastDate)}`
      : 'Aucune sauvegarde automatique effectuée pour le moment.';
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Service worker registration ----------
  let swRegistration = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      swRegistration = reg;
    }).catch((e) => console.warn('SW registration failed', e));
  }

  // ---------- Tabs ----------
  const LAST_TAB_KEY = 'suiviTrail.lastTab.v1';
  const tabButtons = document.querySelectorAll('nav.tabs button');
  const fabButton = document.getElementById('btn-open-plan-modal');

  function activateTab(tabId) {
    tabButtons.forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    const btn = Array.from(tabButtons).find((b) => b.dataset.tab === tabId) || tabButtons[0];
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    fabButton.classList.toggle('hidden', btn.dataset.tab !== 'tab-planning');
    localStorage.setItem(LAST_TAB_KEY, btn.dataset.tab);
    // Canvas charts need the tab visible (non-zero width) to size correctly.
    if (btn.dataset.tab === 'tab-stats') renderEvolutionCharts();
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  activateTab(localStorage.getItem(LAST_TAB_KEY) || 'tab-planning');

  // ---------- Notifications ----------
  const notifBanner = document.getElementById('notif-banner');

  function refreshNotifBanner() {
    const supported = 'Notification' in window;
    if (supported && Notification.permission === 'default') {
      notifBanner.classList.add('show');
    } else {
      notifBanner.classList.remove('show');
    }
  }

  async function requestNotifPermission() {
    if (!('Notification' in window)) {
      alert("Les notifications ne sont pas prises en charge par ce navigateur.");
      return;
    }
    const perm = await Notification.requestPermission();
    refreshNotifBanner();
    if (perm === 'granted') {
      showNotification('Rappels activés 🎉', { body: 'Tu recevras un rappel avant tes sorties planifiées.' });
    }
  }

  function showNotification(title, options) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (swRegistration) {
      swRegistration.showNotification(title, options);
    } else {
      new Notification(title, options);
    }
  }

  document.getElementById('btn-enable-notif').addEventListener('click', requestNotifPermission);
  document.getElementById('btn-enable-notif-2').addEventListener('click', requestNotifPermission);
  document.getElementById('btn-test-notif').addEventListener('click', () => {
    showNotification('Test de rappel 🏔️', { body: "Ceci est une notification de test.", icon: 'icon-192.png' });
  });

  refreshNotifBanner();

  function checkReminders() {
    const now = Date.now();
    data.plans.forEach((p) => {
      if (p.reminded || !p.reminderHours || p.done) return;
      const eventTime = new Date(p.date).getTime();
      const reminderTime = eventTime - Number(p.reminderHours) * 3600 * 1000;
      if (now >= reminderTime && now < eventTime) {
        showNotification(`Rappel : ${p.name}`, {
          body: `Prévu le ${formatDateTime(p.date)}${p.distanceKm ? ` — ${p.distanceKm} km` : ''}`,
          icon: 'icon-192.png',
          tag: 'trail-reminder-' + p.id,
        });
        p.reminded = true;
        saveData();
      }
    });
  }
  setInterval(checkReminders, REMINDER_CHECK_MS);
  checkReminders();

  // ---------- Helpers ----------
  function formatDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('fr-FR', { dateStyle: 'medium' });
  }
  const RESSENTI_LABELS = { 5: '😄 Très bien', 4: '🙂 Bien', 3: '😐 Moyen', 2: '🙁 Difficile', 1: '🥵 Très difficile' };

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function mapsUrl(address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  }

  function weatherUrl(location, dateIso) {
    const dateLabel = formatDate(dateIso);
    return `https://www.google.com/search?q=${encodeURIComponent(`météo ${location} ${dateLabel}`)}`;
  }

  // Parses "hh:mm" or "h:mm:ss" into total minutes, or null if invalid/empty.
  function parseTempsToMinutes(temps) {
    if (!temps) return null;
    const parts = temps.split(':').map(Number);
    if (parts.some((n) => isNaN(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
    return null;
  }

  function formatPace(distanceKm, temps) {
    const minutes = parseTempsToMinutes(temps);
    if (!minutes || !distanceKm) return null;
    const paceMin = minutes / distanceKm;
    const min = Math.floor(paceMin);
    const sec = Math.round((paceMin - min) * 60);
    return `${min}:${String(sec).padStart(2, '0')} /km`;
  }

  const DEFAULT_CHECKLIST = ['Lampe frontale', 'Gels / barres', 'Gourde ou flasks', 'Veste imperméable', 'Téléphone chargé', 'Trousse de secours'];
  const RACE_CHECKLIST_EXTRA = ['Dossard', 'Puce de chronométrage'];

  function buildDefaultChecklist(isRace) {
    const labels = isRace ? [...DEFAULT_CHECKLIST, ...RACE_CHECKLIST_EXTRA] : DEFAULT_CHECKLIST;
    return labels.map((label) => ({ label, checked: false }));
  }

  // ---------- Planning ----------
  const formPlan = document.getElementById('form-plan');
  const btnSubmitPlan = document.getElementById('btn-submit-plan');
  const btnCancelEditPlan = document.getElementById('btn-cancel-edit-plan');
  const formPlanTitle = document.getElementById('form-plan-title');
  const planModalOverlay = document.getElementById('plan-modal-overlay');
  let editingPlanId = null;

  function openPlanModal() {
    planModalOverlay.classList.add('open');
  }

  function closePlanModal() {
    planModalOverlay.classList.remove('open');
  }

  document.getElementById('btn-open-plan-modal').addEventListener('click', () => {
    if (editingPlanId) cancelEditPlan();
    openPlanModal();
  });
  document.getElementById('btn-close-plan-modal').addEventListener('click', () => {
    if (editingPlanId) cancelEditPlan();
    closePlanModal();
  });
  planModalOverlay.addEventListener('click', (e) => {
    if (e.target === planModalOverlay) {
      if (editingPlanId) cancelEditPlan();
      closePlanModal();
    }
  });

  function startEditPlan(plan) {
    editingPlanId = plan.id;
    formPlan.querySelector('[name="name"]').value = plan.name;
    formPlan.querySelector('[name="date"]').value = plan.date.slice(0, 16);
    formPlan.querySelector('[name="distanceKm"]').value = plan.distanceKm ?? '';
    formPlan.querySelector('[name="deniveleM"]').value = plan.deniveleM ?? '';
    formPlan.querySelector('[name="location"]').value = plan.location ?? '';
    formPlan.querySelector('[name="isRace"]').checked = !!plan.isRace;
    formPlan.querySelector('[name="reminderHours"]').value = plan.reminderHours ?? '';
    formPlan.querySelector('[name="notes"]').value = plan.notes ?? '';
    formPlanTitle.textContent = '✏️ Modifier la sortie';
    btnSubmitPlan.textContent = 'Enregistrer les modifications';
    btnCancelEditPlan.style.display = '';
    openPlanModal();
  }

  function cancelEditPlan() {
    editingPlanId = null;
    formPlan.reset();
    formPlan.querySelector('select[name="reminderHours"]').value = '24';
    formPlanTitle.textContent = '➕ Planifier une sortie';
    btnSubmitPlan.textContent = 'Ajouter au planning';
    btnCancelEditPlan.style.display = 'none';
  }

  btnCancelEditPlan.addEventListener('click', () => {
    cancelEditPlan();
    closePlanModal();
  });

  formPlan.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(formPlan);
    const isRace = fd.get('isRace') === 'on';

    if (editingPlanId) {
      const plan = data.plans.find((p) => p.id === editingPlanId);
      if (plan) {
        plan.name = fd.get('name').trim();
        plan.date = fd.get('date');
        plan.distanceKm = fd.get('distanceKm') ? Number(fd.get('distanceKm')) : null;
        plan.deniveleM = fd.get('deniveleM') ? Number(fd.get('deniveleM')) : null;
        plan.location = fd.get('location').trim() || null;
        plan.isRace = isRace;
        plan.reminderHours = fd.get('reminderHours') || null;
        plan.notes = fd.get('notes').trim();
        plan.reminded = false;
        saveData();
      }
      cancelEditPlan();
      closePlanModal();
      renderPlanning();
      renderResultForm();
      return;
    }

    const plan = {
      id: uid(),
      name: fd.get('name').trim(),
      date: fd.get('date'),
      distanceKm: fd.get('distanceKm') ? Number(fd.get('distanceKm')) : null,
      deniveleM: fd.get('deniveleM') ? Number(fd.get('deniveleM')) : null,
      location: fd.get('location').trim() || null,
      isRace,
      checklist: buildDefaultChecklist(isRace),
      reminderHours: fd.get('reminderHours') || null,
      notes: fd.get('notes').trim(),
      done: false,
      reminded: false,
    };
    data.plans.push(plan);
    saveData();
    formPlan.reset();
    formPlan.querySelector('select[name="reminderHours"]').value = '24';
    closePlanModal();
    renderPlanning();
    renderResultForm();
  });

  function renderPlanning() {
    const now = Date.now();
    const upcoming = data.plans.filter((p) => !p.done && new Date(p.date).getTime() >= now)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const past = data.plans.filter((p) => p.done || new Date(p.date).getTime() < now)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    renderCountdown(upcoming);
    renderPlanList('list-planning-upcoming', upcoming, true);
    renderPlanList('list-planning-past', past, false);
    if (calendarVisible) renderCalendar();
  }

  // ---------- Vue calendrier ----------
  let calendarVisible = false;
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedCalDate = null;
  const WEEKDAYS_FR = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  document.getElementById('btn-toggle-calendar').addEventListener('click', () => {
    calendarVisible = !calendarVisible;
    document.getElementById('calendar-view').style.display = calendarVisible ? '' : 'none';
    document.getElementById('list-planning-upcoming').style.display = calendarVisible ? 'none' : '';
    document.getElementById('btn-toggle-calendar').textContent = calendarVisible ? '📋 Vue liste' : '🗓️ Vue calendrier';
    if (calendarVisible) renderCalendar();
  });
  document.getElementById('cal-prev').addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  function toDateKey(dateStr) {
    return dateStr.slice(0, 10);
  }

  function renderCalendar() {
    document.getElementById('cal-month-label').textContent =
      calendarMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const leadingBlanks = (firstDay.getDay() + 6) % 7; // Monday-first grid
    const todayKey = toDateKey(new Date().toISOString());

    const plansByDay = {};
    data.plans.forEach((p) => {
      const key = toDateKey(p.date);
      (plansByDay[key] = plansByDay[key] || []).push(p);
    });

    let html = WEEKDAYS_FR.map((w) => `<div class="cal-weekday">${w}</div>`).join('');
    for (let i = 0; i < leadingBlanks; i++) html += '<div class="cal-day empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const plansToday = plansByDay[dateKey] || [];
      const dots = plansToday.slice(0, 4).map((p) =>
        `<span class="cal-dot${p.isRace ? ' race' : ''}${p.done ? ' done' : ''}"></span>`).join('');
      const classes = ['cal-day'];
      if (dateKey === todayKey) classes.push('today');
      if (dateKey === selectedCalDate) classes.push('selected');
      html += `<div class="${classes.join(' ')}" data-date="${dateKey}">${d}<div class="cal-dots">${dots}</div></div>`;
    }
    document.getElementById('calendar-grid').innerHTML = html;

    document.querySelectorAll('.cal-day[data-date]').forEach((cell) => {
      cell.addEventListener('click', () => {
        selectedCalDate = cell.dataset.date;
        renderCalendar();
        renderCalendarDayDetail(selectedCalDate);
      });
    });

    if (selectedCalDate) renderCalendarDayDetail(selectedCalDate);
  }

  function renderCalendarDayDetail(dateKey) {
    const container = document.getElementById('calendar-day-detail');
    const plans = data.plans.filter((p) => toDateKey(p.date) === dateKey)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (plans.length === 0) {
      container.innerHTML = `<div class="empty">Aucune sortie le ${formatDate(dateKey)}.</div>`;
      return;
    }
    container.innerHTML = plans.map((p) => `
      <div class="item" data-id="${p.id}">
        <div class="item-top">
          <div>
            <div class="item-title">${p.isRace ? '🏆 ' : ''}${escapeHtml(p.name)} ${p.done ? '<span class="badge done">Réalisée</span>' : ''}</div>
            <div class="item-meta">${formatDateTime(p.date)}${p.distanceKm ? ` · ${p.distanceKm} km` : ''}</div>
          </div>
          <div class="item-btns">
            <button class="secondary small btn-cal-edit">✏️</button>
            <button class="danger small btn-cal-del">🗑</button>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.btn-cal-edit').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        const plan = data.plans.find((p) => p.id === id);
        if (plan) startEditPlan(plan);
      });
    });
    container.querySelectorAll('.btn-cal-del').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        if (confirm('Supprimer cette sortie planifiée ?')) {
          data.plans = data.plans.filter((p) => p.id !== id);
          saveData();
          renderPlanning();
          renderResultForm();
          renderCalendarDayDetail(dateKey);
        }
      });
    });
  }

  function renderCountdown(upcoming) {
    const container = document.getElementById('race-countdown');
    if (upcoming.length === 0) {
      container.innerHTML = '';
      return;
    }
    // Prefer the next race if there is one, otherwise the next planned outing.
    const next = upcoming.find((p) => p.isRace) || upcoming[0];
    const now = Date.now();
    const eventTime = new Date(next.date).getTime();
    const days = Math.ceil((eventTime - now) / (24 * 3600 * 1000));
    container.innerHTML = `
      <div class="countdown-card">
        <div class="cd-label">${next.isRace ? 'Prochaine course' : 'Prochaine sortie'}</div>
        <div class="cd-name">${next.isRace ? '🏆 ' : '🏃 '}${escapeHtml(next.name)}</div>
        <div class="cd-days">${days <= 0 ? "C'est aujourd'hui !" : `J-${days}`}</div>
        <div class="cd-sub">${formatDateTime(next.date)}${next.location ? ` · ${escapeHtml(next.location)}` : ''}</div>
      </div>
    `;
  }

  function renderPlanList(containerId, items, isUpcoming) {
    const container = document.getElementById(containerId);
    if (items.length === 0) {
      container.innerHTML = `<div class="empty">${isUpcoming ? 'Aucune sortie planifiée.' : 'Aucune sortie passée.'}</div>`;
      return;
    }
    container.innerHTML = items.map((p) => {
      const checklist = p.checklist || [];
      const checkedCount = checklist.filter((c) => c.checked).length;
      return `
      <div class="item" data-id="${p.id}">
        <div class="item-top">
          <div>
            <div class="item-title">${p.isRace ? '🏆 ' : ''}${escapeHtml(p.name)} ${p.done ? '<span class="badge done">Réalisée</span>' : ''}</div>
            <div class="item-meta">${formatDateTime(p.date)}${p.distanceKm ? ` · ${p.distanceKm} km` : ''}${p.deniveleM ? ` · D+ ${p.deniveleM} m` : ''}</div>
            ${p.location ? `<div class="item-meta">📍 ${escapeHtml(p.location)} · <a href="${mapsUrl(p.location)}" target="_blank" rel="noopener noreferrer">Voir sur Maps</a>${isUpcoming ? ` · <a href="${weatherUrl(p.location, p.date)}" target="_blank" rel="noopener noreferrer">🌦️ Météo</a>` : ''}</div>` : ''}
          </div>
          <div class="item-btns">
            ${isUpcoming && p.isRace ? `<button class="secondary small btn-gen-plan">📋 Plan</button>` : ''}
            ${isUpcoming ? `<button class="secondary small btn-done">✓ Fait</button>` : ''}
            ${!isUpcoming && p.done ? `<button class="secondary small btn-undone">↩️ Annuler</button>` : ''}
            <button class="secondary small btn-edit">✏️</button>
            <button class="danger small btn-del">🗑</button>
          </div>
        </div>
        ${p.notes ? `<div class="item-notes">${escapeHtml(p.notes)}</div>` : ''}
        <details class="checklist">
          <summary>🎒 Checklist (${checkedCount}/${checklist.length})</summary>
          <div class="checklist-items">
            ${checklist.map((c, idx) => `
              <div class="checklist-item">
                <label style="display:flex;align-items:center;gap:8px;flex:1;">
                  <input type="checkbox" data-check-idx="${idx}" ${c.checked ? 'checked' : ''} />
                  ${escapeHtml(c.label)}
                </label>
                <button type="button" class="danger small btn-del-check" data-check-idx="${idx}">✕</button>
              </div>
            `).join('')}
            <div class="checklist-add">
              <input type="text" class="new-check-item" placeholder="Ajouter un élément" />
              <button type="button" class="secondary small btn-add-check">+</button>
            </div>
          </div>
        </details>
      </div>
    `;
    }).join('');

    container.querySelectorAll('.btn-del').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        if (confirm('Supprimer cette sortie planifiée ?')) {
          data.plans = data.plans.filter((p) => p.id !== id);
          saveData();
          renderPlanning();
          renderResultForm();
        }
      });
    });
    container.querySelectorAll('.btn-done')?.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        const plan = data.plans.find((p) => p.id === id);
        if (plan) {
          plan.done = true;
          saveData();
          renderPlanning();
          prefillResultFromPlan(plan);
          activateTab('tab-results');
          openResultModal();
        }
      });
    });
    container.querySelectorAll('.btn-gen-plan').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        const race = data.plans.find((p) => p.id === id);
        if (race) generateTrainingPlan(race);
      });
    });
    container.querySelectorAll('.btn-edit').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        const plan = data.plans.find((p) => p.id === id);
        if (plan) {
          startEditPlan(plan);
          activateTab('tab-planning');
        }
      });
    });
    container.querySelectorAll('.btn-undone').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        const plan = data.plans.find((p) => p.id === id);
        if (plan) {
          plan.done = false;
          saveData();
          renderPlanning();
          renderResultForm();
        }
      });
    });
    container.querySelectorAll('[data-check-idx]').forEach((chk) => {
      if (chk.type !== 'checkbox') return;
      chk.addEventListener('change', (e) => {
        const id = e.target.closest('.item').dataset.id;
        const idx = Number(e.target.dataset.checkIdx);
        const plan = data.plans.find((p) => p.id === id);
        if (plan && plan.checklist[idx]) {
          plan.checklist[idx].checked = e.target.checked;
          saveData();
          const summary = e.target.closest('.checklist').querySelector('summary');
          const checkedCount = plan.checklist.filter((c) => c.checked).length;
          summary.textContent = `🎒 Checklist (${checkedCount}/${plan.checklist.length})`;
        }
      });
    });
    container.querySelectorAll('.btn-del-check').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const itemEl = e.target.closest('.item');
        const id = itemEl.dataset.id;
        const idx = Number(e.target.dataset.checkIdx);
        const plan = data.plans.find((p) => p.id === id);
        if (plan && plan.checklist[idx]) {
          const wasOpen = itemEl.querySelector('.checklist').open;
          plan.checklist.splice(idx, 1);
          saveData();
          renderPlanning();
          if (wasOpen) {
            const refreshed = container.querySelector(`.item[data-id="${id}"] .checklist`);
            if (refreshed) refreshed.open = true;
          }
        }
      });
    });
    container.querySelectorAll('.btn-add-check').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const itemEl = e.target.closest('.item');
        const id = itemEl.dataset.id;
        const input = itemEl.querySelector('.new-check-item');
        const label = input.value.trim();
        if (!label) return;
        const plan = data.plans.find((p) => p.id === id);
        if (plan) {
          plan.checklist = plan.checklist || [];
          plan.checklist.push({ label, checked: false });
          saveData();
          renderPlanning();
          const refreshed = container.querySelector(`.item[data-id="${id}"] .checklist`);
          if (refreshed) refreshed.open = true;
        }
      });
    });
  }

  // Generates weekly training sessions (fractionné / sortie moyenne / sortie longue) leading up to a race.
  function generateTrainingPlan(race) {
    const weeksInput = prompt('Sur combien de semaines veux-tu générer le plan d\'entraînement ?', '8');
    if (!weeksInput) return;
    const weeks = Math.max(1, Math.min(20, parseInt(weeksInput, 10) || 0));
    if (!weeks) {
      alert('Nombre de semaines invalide.');
      return;
    }
    const raceDate = new Date(race.date);
    let created = 0;
    for (let w = weeks; w >= 1; w--) {
      const weekStart = new Date(raceDate);
      weekStart.setDate(weekStart.getDate() - w * 7);
      const isTaperWeek = w === 1;
      const sessions = isTaperWeek
        ? [{ offset: 2, name: 'Sortie allégée (semaine avant course)', km: 6 }]
        : [
            { offset: 1, name: 'Fractionné', km: 8 },
            { offset: 3, name: 'Sortie moyenne', km: 12 },
            { offset: 6, name: 'Sortie longue', km: 18 + Math.min(w, 6) },
          ];
      sessions.forEach((s) => {
        const sessionDate = new Date(weekStart);
        sessionDate.setDate(sessionDate.getDate() + s.offset);
        sessionDate.setHours(9, 0, 0, 0);
        if (sessionDate.getTime() <= Date.now() || sessionDate >= raceDate) return;
        data.plans.push({
          id: uid(),
          name: `${s.name} (prépa ${race.name})`,
          date: sessionDate.toISOString().slice(0, 16),
          distanceKm: s.km,
          deniveleM: null,
          location: race.location || null,
          isRace: false,
          checklist: buildDefaultChecklist(false),
          reminderHours: '24',
          notes: `Séance de préparation pour ${race.name}`,
          done: false,
          reminded: false,
        });
        created++;
      });
    }
    saveData();
    renderPlanning();
    renderResultForm();
    alert(`${created} séances d'entraînement ajoutées au planning.`);
  }

  function prefillResultFromPlan(plan) {
    const form = document.getElementById('form-result');
    form.querySelector('[name="plannedId"]').value = plan.id;
    form.querySelector('[name="name"]').value = plan.name;
    form.querySelector('[name="date"]').value = plan.date.slice(0, 10);
    if (plan.distanceKm) form.querySelector('[name="distanceKm"]').value = plan.distanceKm;
    if (plan.deniveleM) form.querySelector('[name="deniveleM"]').value = plan.deniveleM;
  }

  // ---------- Résultats ----------
  const formResult = document.getElementById('form-result');
  const selectPlannedId = formResult.querySelector('[name="plannedId"]');
  const resultModalOverlay = document.getElementById('result-modal-overlay');
  const importModalOverlay = document.getElementById('import-modal-overlay');
  const formResultTitle = document.getElementById('form-result-title');
  const btnSubmitResult = document.getElementById('btn-submit-result');
  const btnCancelEditResult = document.getElementById('btn-cancel-edit-result');
  let editingResultId = null;

  function openResultModal() { resultModalOverlay.classList.add('open'); }
  function closeResultModal() { resultModalOverlay.classList.remove('open'); }
  function openImportModal() { importModalOverlay.classList.add('open'); }
  function closeImportModal() { importModalOverlay.classList.remove('open'); }

  function resetResultForm() {
    editingResultId = null;
    pendingGpxTrack = null;
    pendingPhotoDataUrl = null;
    photoRemoved = false;
    formResult.reset();
    formResult.querySelector('[name="ressenti"]').value = '3';
    document.getElementById('photo-preview').style.display = 'none';
    document.getElementById('photo-preview-img').src = '';
    formResultTitle.textContent = '➕ Ajouter un résultat';
    btnSubmitResult.textContent = 'Enregistrer le résultat';
    btnCancelEditResult.style.display = 'none';
  }

  function startEditResult(result) {
    editingResultId = result.id;
    pendingGpxTrack = null;
    pendingPhotoDataUrl = null;
    photoRemoved = false;
    formResult.querySelector('[name="plannedId"]').value = result.plannedId || '';
    formResult.querySelector('[name="name"]').value = result.name;
    formResult.querySelector('[name="date"]').value = result.date;
    formResult.querySelector('[name="distanceKm"]').value = result.distanceKm ?? '';
    formResult.querySelector('[name="deniveleM"]').value = result.deniveleM ?? '';
    formResult.querySelector('[name="temps"]').value = result.temps ?? '';
    formResult.querySelector('[name="ressenti"]').value = result.ressenti;
    formResult.querySelector('[name="notes"]').value = result.notes ?? '';
    if (result.photo) {
      document.getElementById('photo-preview-img').src = result.photo;
      document.getElementById('photo-preview').style.display = '';
    } else {
      document.getElementById('photo-preview').style.display = 'none';
    }
    formResultTitle.textContent = '✏️ Modifier le résultat';
    btnSubmitResult.textContent = 'Enregistrer les modifications';
    btnCancelEditResult.style.display = '';
    openResultModal();
  }

  document.getElementById('btn-open-result-modal').addEventListener('click', () => {
    resetResultForm();
    openResultModal();
  });
  document.getElementById('btn-close-result-modal').addEventListener('click', () => {
    resetResultForm();
    closeResultModal();
  });
  btnCancelEditResult.addEventListener('click', () => {
    resetResultForm();
    closeResultModal();
  });
  resultModalOverlay.addEventListener('click', (e) => {
    if (e.target === resultModalOverlay) {
      resetResultForm();
      closeResultModal();
    }
  });

  document.getElementById('btn-open-import-modal').addEventListener('click', openImportModal);
  document.getElementById('btn-close-import-modal').addEventListener('click', closeImportModal);
  importModalOverlay.addEventListener('click', (e) => { if (e.target === importModalOverlay) closeImportModal(); });

  selectPlannedId.addEventListener('change', () => {
    const plan = data.plans.find((p) => p.id === selectPlannedId.value);
    if (plan) prefillResultFromPlan(plan);
  });

  // ---------- Import GPX (Suunto, Garmin, etc.) ----------
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Smooths noisy 1Hz elevation data then uses a hysteresis threshold to avoid
  // counting barometric/GPS noise as real climbing (naive diff-sum wildly over/under-estimates D+).
  function computeElevationGain(elevations) {
    if (elevations.length < 3) return 0;
    const windowSize = 9;
    const half = Math.floor(windowSize / 2);
    const smoothed = elevations.map((_, i) => {
      const start = Math.max(0, i - half);
      const end = Math.min(elevations.length, i + half + 1);
      const slice = elevations.slice(start, end);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });
    const threshold = 1.5; // meters; ignore fluctuations smaller than this
    let gain = 0;
    let baseline = smoothed[0];
    for (let i = 1; i < smoothed.length; i++) {
      const diff = smoothed[i] - baseline;
      if (diff > threshold) {
        gain += diff;
        baseline = smoothed[i];
      } else if (diff < -threshold) {
        baseline = smoothed[i];
      }
    }
    return Math.round(gain);
  }

  // Picks evenly-spaced samples to keep stored track/elevation data small in localStorage.
  function downsample(arr, maxPoints) {
    if (arr.length <= maxPoints) return arr;
    const step = arr.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  }

  function parseGpx(xmlText) {
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('Fichier GPX invalide ou corrompu.');

    const trkpts = Array.from(xml.getElementsByTagName('trkpt')).map((pt) => {
      const timeEl = pt.getElementsByTagName('time')[0];
      const eleEl = pt.getElementsByTagName('ele')[0];
      return {
        lat: parseFloat(pt.getAttribute('lat')),
        lon: parseFloat(pt.getAttribute('lon')),
        ele: eleEl ? parseFloat(eleEl.textContent) : null,
        time: timeEl ? new Date(timeEl.textContent) : null,
      };
    });
    if (trkpts.length < 2) throw new Error('Aucune trace GPS exploitable dans ce fichier.');

    let distanceKm = 0;
    for (let i = 1; i < trkpts.length; i++) {
      const a = trkpts[i - 1];
      const b = trkpts[i];
      distanceKm += haversineKm(a.lat, a.lon, b.lat, b.lon);
    }
    const elevations = trkpts.map((p) => p.ele).filter((e) => e !== null);
    const deniveleM = computeElevationGain(elevations);

    const times = trkpts.map((p) => p.time).filter(Boolean);
    const nameEl = xml.querySelector('trk > name');
    let temps = null;
    if (times.length >= 2) {
      const totalMin = (times[times.length - 1].getTime() - times[0].getTime()) / 60000;
      const h = Math.floor(totalMin / 60);
      const m = Math.round(totalMin % 60);
      temps = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    return {
      name: nameEl ? nameEl.textContent.trim() : null,
      date: times.length ? times[0].toISOString().slice(0, 10) : null,
      distanceKm: Math.round(distanceKm * 100) / 100,
      deniveleM,
      temps,
      track: downsample(trkpts.map((p) => [p.lat, p.lon]), 150),
      elevations: downsample(elevations, 80),
    };
  }

  let pendingGpxTrack = null;
  let pendingPhotoDataUrl = null;
  let photoRemoved = false;

  document.getElementById('input-photo').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      loadImage(reader.result).then((img) => {
        if (!img.naturalWidth || !img.naturalHeight) {
          throw new Error('Format image non supporté.');
        }
        const maxW = 1000;
        const scale = Math.min(1, maxW / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        // White backdrop: JPEG has no alpha channel, so any transparent source pixels
        // would otherwise turn black once exported as JPEG.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        pendingPhotoDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        photoRemoved = false;
        document.getElementById('photo-preview-img').src = pendingPhotoDataUrl;
        document.getElementById('photo-preview').style.display = '';
      }).catch(() => alert('Impossible de charger cette image (essaie un JPEG ou PNG).'));
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  document.getElementById('btn-remove-photo').addEventListener('click', () => {
    pendingPhotoDataUrl = null;
    photoRemoved = true;
    document.getElementById('photo-preview').style.display = 'none';
    document.getElementById('photo-preview-img').src = '';
  });

  document.getElementById('input-gpx').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseGpx(reader.result);
        // Auto-link to a planned outing scheduled the same day, if any.
        const matchedPlan = parsed.date
          ? data.plans.find((p) => toDateKey(p.date) === parsed.date)
          : null;
        formResult.querySelector('[name="plannedId"]').value = matchedPlan ? matchedPlan.id : '';
        formResult.querySelector('[name="name"]').value =
          parsed.name || (matchedPlan ? matchedPlan.name : null) || file.name.replace(/\.gpx$/i, '');
        if (parsed.date) formResult.querySelector('[name="date"]').value = parsed.date;
        if (parsed.distanceKm) formResult.querySelector('[name="distanceKm"]').value = parsed.distanceKm;
        if (parsed.deniveleM) formResult.querySelector('[name="deniveleM"]').value = parsed.deniveleM;
        if (parsed.temps) formResult.querySelector('[name="temps"]').value = parsed.temps;
        pendingGpxTrack = { track: parsed.track, elevations: parsed.elevations };
        closeImportModal();
        openResultModal();
      } catch (err) {
        alert('Import impossible : ' + err.message);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  formResult.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(formResult);
    const fields = {
      plannedId: fd.get('plannedId') || null,
      name: fd.get('name').trim(),
      date: fd.get('date'),
      distanceKm: fd.get('distanceKm') ? Number(fd.get('distanceKm')) : null,
      deniveleM: fd.get('deniveleM') ? Number(fd.get('deniveleM')) : null,
      temps: fd.get('temps').trim() || null,
      ressenti: Number(fd.get('ressenti')),
      notes: fd.get('notes').trim(),
    };

    if (editingResultId) {
      const result = data.results.find((r) => r.id === editingResultId);
      if (result) {
        Object.assign(result, fields);
        if (pendingGpxTrack) {
          result.track = pendingGpxTrack.track;
          result.elevations = pendingGpxTrack.elevations;
        }
        if (pendingPhotoDataUrl) result.photo = pendingPhotoDataUrl;
        else if (photoRemoved) result.photo = null;
        if (result.plannedId) {
          const plan = data.plans.find((p) => p.id === result.plannedId);
          if (plan) plan.done = true;
        }
        saveData();
      }
      resetResultForm();
      closeResultModal();
      renderResults();
      renderPlanning();
      renderResultForm();
      renderStats();
      return;
    }

    const result = {
      id: uid(),
      ...fields,
      track: pendingGpxTrack ? pendingGpxTrack.track : null,
      elevations: pendingGpxTrack ? pendingGpxTrack.elevations : null,
      photo: pendingPhotoDataUrl,
    };
    data.results.push(result);
    if (result.plannedId) {
      const plan = data.plans.find((p) => p.id === result.plannedId);
      if (plan) plan.done = true;
    }
    saveData();
    resetResultForm();
    closeResultModal();
    renderResults();
    renderPlanning();
    renderResultForm();
    renderStats();
  });

  function renderResultForm() {
    const upcoming = [...data.plans].sort((a, b) => new Date(b.date) - new Date(a.date));
    selectPlannedId.innerHTML = '<option value="">— Aucune (saisie libre) —</option>' +
      upcoming.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} — ${formatDate(p.date)}</option>`).join('');
  }

  function renderResults() {
    const container = document.getElementById('list-results');
    const items = [...data.results].sort((a, b) => new Date(b.date) - new Date(a.date));
    if (items.length === 0) {
      container.innerHTML = '<div class="empty">Aucun résultat enregistré pour le moment.</div>';
      return;
    }
    container.innerHTML = items.map((r) => {
      const pace = formatPace(r.distanceKm, r.temps);
      const hasTrack = r.track && r.track.length > 1;
      const hasElevations = r.elevations && r.elevations.length > 1;
      return `
      <div class="item" data-id="${r.id}">
        <div class="item-top">
          <div>
            <div class="item-title">${escapeHtml(r.name)}</div>
            <div class="item-meta">
              ${formatDate(r.date)}${r.distanceKm ? ` · ${r.distanceKm} km` : ''}${r.deniveleM ? ` · D+ ${r.deniveleM} m` : ''}${r.temps ? ` · ${escapeHtml(r.temps)}` : ''}${pace ? ` · ${pace}` : ''}
              <span class="badge">${RESSENTI_LABELS[r.ressenti] || ''}</span>
            </div>
          </div>
          <div class="item-btns">
            <button class="secondary small btn-share" data-format="card" title="Partager en carte">🖼️</button>
            <button class="secondary small btn-share" data-format="story" title="Partager en story">📱</button>
            <button class="secondary small btn-edit-result">✏️</button>
            <button class="danger small btn-del">🗑</button>
          </div>
        </div>
        ${r.notes ? `<div class="item-notes">${escapeHtml(r.notes)}</div>` : ''}
        ${r.photo ? `<img class="result-photo" src="${r.photo}" alt="Photo de ${escapeHtml(r.name)}" />` : ''}
        ${(hasTrack || hasElevations) ? `
        <div class="result-charts">
          ${hasTrack ? `<div class="chart-block"><div class="chart-title">Tracé</div><canvas id="track-${r.id}" width="300" height="120"></canvas></div>` : ''}
          ${hasElevations ? `<div class="chart-block"><div class="chart-title">Profil altimétrique</div><canvas id="elev-${r.id}" width="300" height="90"></canvas></div>` : ''}
        </div>` : ''}
      </div>
    `;
    }).join('');

    container.querySelectorAll('.btn-del').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        if (confirm('Supprimer ce résultat ?')) {
          data.results = data.results.filter((r) => r.id !== id);
          saveData();
          renderResults();
          renderStats();
        }
      });
    });
    container.querySelectorAll('.btn-share').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        const result = data.results.find((r) => r.id === id);
        if (result) shareResult(result, e.target.dataset.format || 'card');
      });
    });
    container.querySelectorAll('.btn-edit-result').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('.item').dataset.id;
        const result = data.results.find((r) => r.id === id);
        if (result) startEditResult(result);
      });
    });

    items.forEach((r) => {
      if (r.track && r.track.length > 1) drawRouteShape(`track-${r.id}`, r.track);
      if (r.elevations && r.elevations.length > 1) drawElevationProfile(`elev-${r.id}`, r.elevations);
    });
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function drawGridBackground(ctx, x, y, w, h, hLines, vLines) {
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.lineWidth = 1;
    for (let i = 1; i < hLines; i++) {
      const gy = y + (h / hLines) * i;
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
      ctx.stroke();
    }
    for (let i = 1; i < vLines; i++) {
      const gx = x + (w / vLines) * i;
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
      ctx.stroke();
    }
  }

  function drawRouteShapeOnCtx(ctx, offsetX0, offsetY0, width, height, track) {
    drawGridBackground(ctx, offsetX0, offsetY0, width, height, 3, 3);
    const pad = 10;
    const avgLat = track.reduce((s, p) => s + p[0], 0) / track.length;
    const latRad = avgLat * Math.PI / 180;
    const points = track.map(([lat, lon]) => ({ x: lon * Math.cos(latRad), y: -lat }));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scale = Math.min((width - pad * 2) / rangeX, (height - pad * 2) / rangeY);
    const offsetX = offsetX0 + pad + ((width - pad * 2) - rangeX * scale) / 2;
    const offsetY = offsetY0 + pad + ((height - pad * 2) - rangeY * scale) / 2;

    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = offsetX + (p.x - minX) * scale;
      const y = offsetY + (p.y - minY) * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#facc15';
    const start = points[0];
    ctx.beginPath();
    ctx.arc(offsetX + (start.x - minX) * scale, offsetY + (start.y - minY) * scale, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawElevationProfileOnCtx(ctx, offsetX, offsetY, width, height, elevations) {
    drawGridBackground(ctx, offsetX, offsetY, width, height, 3, 4);
    const padTop = 8;
    const padBottom = 4;
    const min = Math.min(...elevations);
    const max = Math.max(...elevations);
    const range = max - min || 1;
    const plotHeight = height - padTop - padBottom;
    const stepX = width / (elevations.length - 1);

    const gradient = ctx.createLinearGradient(0, offsetY + padTop, 0, offsetY + height - padBottom);
    gradient.addColorStop(0, 'rgba(250,204,21,0.35)');
    gradient.addColorStop(1, 'rgba(250,204,21,0.02)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(offsetX, offsetY + height - padBottom);
    elevations.forEach((e, i) => {
      const x = offsetX + i * stepX;
      const y = offsetY + padTop + (1 - (e - min) / range) * plotHeight;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(offsetX + width, offsetY + height - padBottom);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2;
    ctx.beginPath();
    elevations.forEach((e, i) => {
      const x = offsetX + i * stepX;
      const y = offsetY + padTop + (1 - (e - min) / range) * plotHeight;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawRouteShape(canvasId, track) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas, 120);
    drawRouteShapeOnCtx(ctx, 0, 0, width, height, track);
  }

  function drawElevationProfile(canvasId, elevations) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas, 90);
    drawElevationProfileOnCtx(ctx, 0, 0, width, height, elevations);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        // decode() ensures the bitmap is fully ready before we draw it to a canvas.
        if (img.decode) img.decode().then(() => resolve(img)).catch(() => resolve(img));
        else resolve(img);
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  // ---------- Partage résultat ----------
  const STAT_ICONS = { distance: '📏', denivele: '⛰️', temps: '⏱️', allure: '⚡' };

  async function buildResultShareImage(result, format = 'card') {
    const isStory = format === 'story';
    const width = isStory ? 900 : 800;
    const hasPhoto = !!result.photo;
    const hasTrack = result.track && result.track.length > 1;
    const hasElevations = result.elevations && result.elevations.length > 1;
    const hasVisuals = hasTrack || hasElevations;

    const photoHeight = hasPhoto ? (isStory ? 760 : 300) : 0;
    const headerHeight = hasPhoto ? (isStory ? 170 : 130) : (isStory ? 140 : 110);
    const statsHeight = isStory ? 150 : 120;
    const visualsHeight = hasVisuals ? (isStory ? 280 : 220) : 0;
    const ressentiHeight = 60;
    const margin = 32;
    const height = photoHeight + headerHeight + statsHeight + visualsHeight + ressentiHeight + margin;

    let photoImg = null;
    if (hasPhoto) {
      try { photoImg = await loadImage(result.photo); } catch (e) { photoImg = null; }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Rounded card with a subtle navy-to-green gradient background.
    roundRectPath(ctx, 0, 0, width, height, 28);
    ctx.clip();
    const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
    bgGradient.addColorStop(0, '#0f172a');
    bgGradient.addColorStop(1, '#052e1d');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    let cursorY = 0;
    const ressentiColors = { 5: '#22c55e', 4: '#22c55e', 3: '#facc15', 2: '#fb923c', 1: '#f87171' };
    const accent = ressentiColors[result.ressenti] || '#22c55e';

    if (photoImg) {
      const scale = Math.max(width / photoImg.naturalWidth, photoHeight / photoImg.naturalHeight);
      const sw = width / scale;
      const sh = photoHeight / scale;
      const sx = (photoImg.naturalWidth - sw) / 2;
      const sy = (photoImg.naturalHeight - sh) / 2;
      ctx.drawImage(photoImg, sx, sy, sw, sh, 0, 0, width, photoHeight);

      // Dark gradient so the title stays readable over any photo.
      const overlayHeight = headerHeight + 60;
      const overlay = ctx.createLinearGradient(0, photoHeight - overlayHeight, 0, photoHeight);
      overlay.addColorStop(0, 'rgba(15,23,42,0)');
      overlay.addColorStop(1, 'rgba(15,23,42,0.92)');
      ctx.fillStyle = overlay;
      ctx.fillRect(0, photoHeight - overlayHeight, width, overlayHeight);

      ctx.fillStyle = accent;
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText('🏔️ Suivi Trail', margin, photoHeight - headerHeight + 24);

      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${isStory ? 36 : 30}px system-ui, sans-serif`;
      wrapText(ctx, result.name, margin, photoHeight - headerHeight + 62, width - margin * 2, isStory ? 40 : 34);

      ctx.font = '18px system-ui, sans-serif';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(formatDate(result.date), margin, photoHeight - 16);
      cursorY += photoHeight;
    } else {
      ctx.fillStyle = accent;
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText('🏔️ Suivi Trail', margin, cursorY + 34);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = `bold ${isStory ? 36 : 30}px system-ui, sans-serif`;
      wrapText(ctx, result.name, margin, cursorY + 72, width - margin * 2, isStory ? 40 : 34);

      ctx.font = '18px system-ui, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(formatDate(result.date), margin, cursorY + headerHeight - 10);
      cursorY += headerHeight;
    }

    const pace = formatPace(result.distanceKm, result.temps);
    const stats = [
      result.distanceKm ? [STAT_ICONS.distance, `${result.distanceKm} km`, 'Distance'] : null,
      result.deniveleM ? [STAT_ICONS.denivele, `${Math.round(result.deniveleM)} m`, 'D+'] : null,
      result.temps ? [STAT_ICONS.temps, result.temps, 'Temps'] : null,
      pace ? [STAT_ICONS.allure, pace, 'Allure'] : null,
    ].filter(Boolean);

    const cols = isStory ? 2 : stats.length;
    const rows = Math.ceil(stats.length / cols);
    const gap = 14;
    const boxWidth = (width - margin * 2 - gap * (cols - 1)) / cols;
    const boxHeight = (statsHeight - 10 - gap * (rows - 1)) / rows;
    stats.forEach((s, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = margin + col * (boxWidth + gap);
      const y = cursorY + row * (boxHeight + gap);
      roundRectPath(ctx, x, y, boxWidth, boxHeight, 12);
      ctx.fillStyle = 'rgba(34,197,94,0.12)';
      ctx.fill();
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillStyle = accent;
      ctx.fillText(s[0], x + 14, y + 28);
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(s[1], x + 44, y + 28);
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(s[2], x + 14, y + boxHeight - 12);
    });
    cursorY += statsHeight;

    if (hasVisuals) {
      const vGap = 16;
      const stacked = isStory;
      const boxH = stacked ? (visualsHeight - 30) / (hasTrack && hasElevations ? 2 : 1) - vGap / 2 : visualsHeight - 30;
      if (stacked) {
        let vy = cursorY;
        if (hasTrack) {
          roundRectPath(ctx, margin, vy, width - margin * 2, boxH, 12);
          ctx.fillStyle = '#1e293b';
          ctx.fill();
          drawRouteShapeOnCtx(ctx, margin, vy, width - margin * 2, boxH, result.track);
          vy += boxH + vGap;
        }
        if (hasElevations) {
          roundRectPath(ctx, margin, vy, width - margin * 2, boxH, 12);
          ctx.fillStyle = '#1e293b';
          ctx.fill();
          drawElevationProfileOnCtx(ctx, margin, vy, width - margin * 2, boxH, result.elevations);
        }
      } else {
        const half = (width - margin * 2 - vGap) / 2;
        if (hasTrack) {
          roundRectPath(ctx, margin, cursorY, half, boxH, 12);
          ctx.fillStyle = '#1e293b';
          ctx.fill();
          drawRouteShapeOnCtx(ctx, margin, cursorY, half, boxH, result.track);
        }
        if (hasElevations) {
          const x2 = margin + (hasTrack ? half + vGap : 0);
          const w2 = hasTrack ? half : width - margin * 2;
          roundRectPath(ctx, x2, cursorY, w2, boxH, 12);
          ctx.fillStyle = '#1e293b';
          ctx.fill();
          drawElevationProfileOnCtx(ctx, x2, cursorY, w2, boxH, result.elevations);
        }
      }
      cursorY += visualsHeight;
    }

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText(RESSENTI_LABELS[result.ressenti] || '', margin, cursorY + 30);

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    let curY = y;
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, curY);
        line = word;
        curY += lineHeight;
      } else {
        line = test;
      }
    });
    if (line) ctx.fillText(line, x, curY);
  }

  async function shareResult(result, format = 'card') {
    const blob = await buildResultShareImage(result, format);
    const pace = formatPace(result.distanceKm, result.temps);
    const text = `${result.name} — ${formatDate(result.date)}` +
      (result.distanceKm ? ` · ${result.distanceKm} km` : '') +
      (result.deniveleM ? ` · D+ ${result.deniveleM} m` : '') +
      (result.temps ? ` · ${result.temps}` : '') +
      (pace ? ` · ${pace}` : '');
    const file = new File([blob], `${result.name.replace(/[^a-z0-9]+/gi, '-')}.png`, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: result.name, text });
        return;
      } catch (e) { /* user cancelled or share failed, fall through to download */ }
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: result.name, text });
        return;
      } catch (e) { /* user cancelled, fall through to download */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.name.replace(/[^a-z0-9]+/gi, '-')}.png`;
    a.click();
    URL.revokeObjectURL(url);
    alert("Le partage direct n'est pas disponible : l'image récapitulative a été téléchargée à la place.");
  }

  // ---------- Stats ----------
  function renderStats() {
    const container = document.getElementById('stats-grid');
    const totalSorties = data.results.length;
    const totalKm = data.results.reduce((s, r) => s + (r.distanceKm || 0), 0);
    const totalDplus = data.results.reduce((s, r) => s + (r.deniveleM || 0), 0);
    const upcoming = data.plans.filter((p) => !p.done && new Date(p.date).getTime() >= Date.now()).length;

    const boxes = [
      { val: totalSorties, lbl: 'Sorties réalisées' },
      { val: totalKm.toFixed(1) + ' km', lbl: 'Distance cumulée' },
      { val: Math.round(totalDplus) + ' m', lbl: 'D+ cumulé' },
      { val: upcoming, lbl: 'Sorties à venir' },
    ];
    container.innerHTML = boxes.map((b) => `
      <div class="stat-box"><div class="val">${b.val}</div><div class="lbl">${b.lbl}</div></div>
    `).join('');

    renderEvolutionCharts();
  }

  // ---------- Graphiques d'évolution hebdomadaire ----------
  function getWeekStart(dateStr) {
    const d = new Date(dateStr);
    const day = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function buildWeeklyStats() {
    const weeks = new Map();
    data.results.forEach((r) => {
      const weekStart = getWeekStart(r.date);
      const key = weekStart.getTime();
      if (!weeks.has(key)) weeks.set(key, { weekStart, km: 0, denivele: 0, paceSum: 0, paceCount: 0 });
      const w = weeks.get(key);
      w.km += r.distanceKm || 0;
      w.denivele += r.deniveleM || 0;
      const minutes = parseTempsToMinutes(r.temps);
      if (minutes && r.distanceKm) {
        w.paceSum += minutes / r.distanceKm;
        w.paceCount++;
      }
    });
    return Array.from(weeks.values())
      .sort((a, b) => a.weekStart - b.weekStart)
      .slice(-10)
      .map((w) => ({
        label: w.weekStart.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }),
        km: Math.round(w.km * 10) / 10,
        denivele: Math.round(w.denivele),
        pace: w.paceCount ? w.paceSum / w.paceCount : null,
      }));
  }

  function renderEvolutionCharts() {
    const weekly = buildWeeklyStats();
    const emptyMsg = document.getElementById('evolution-empty');
    const chartsDiv = document.getElementById('evolution-charts');
    if (weekly.length < 2) {
      emptyMsg.style.display = '';
      chartsDiv.style.display = 'none';
      return;
    }
    emptyMsg.style.display = 'none';
    chartsDiv.style.display = '';

    drawBarChart('chart-distance', weekly.map((w) => w.label), weekly.map((w) => w.km), '#22c55e', 'km');
    drawBarChart('chart-denivele', weekly.map((w) => w.label), weekly.map((w) => w.denivele), '#facc15', 'm');
    drawLineChart('chart-allure', weekly.map((w) => w.label), weekly.map((w) => w.pace));
  }

  function setupCanvas(canvas, height = 140) {
    const ctx = canvas.getContext('2d');
    const cssWidth = canvas.clientWidth || 600;
    const cssHeight = height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = cssWidth * ratio;
    canvas.height = cssHeight * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function drawBarChart(canvasId, labels, values, color, unit) {
    const canvas = document.getElementById(canvasId);
    const { ctx, width, height } = setupCanvas(canvas);
    const padTop = 16;
    const padBottom = 20;
    const max = Math.max(...values, 1);
    const barAreaHeight = height - padTop - padBottom;
    const barWidth = width / values.length;

    values.forEach((v, i) => {
      const barHeight = (v / max) * barAreaHeight;
      const x = i * barWidth + barWidth * 0.2;
      const y = padTop + (barAreaHeight - barHeight);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, barWidth * 0.6, barHeight);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      if (v > 0) ctx.fillText(`${v}${unit}`, x + barWidth * 0.3, y - 4 < padTop ? padTop + 10 : y - 4);

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(labels[i], x + barWidth * 0.3, height - 4);
    });
  }

  function drawLineChart(canvasId, labels, values) {
    const canvas = document.getElementById(canvasId);
    const { ctx, width, height } = setupCanvas(canvas);
    const padTop = 16;
    const padBottom = 20;
    const valid = values.filter((v) => v !== null && v !== undefined);
    if (valid.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Pas encore de temps enregistrés', width / 2, height / 2);
      return;
    }
    const max = Math.max(...valid);
    const min = Math.min(...valid);
    const range = max - min || 1;
    const plotHeight = height - padTop - padBottom;
    const stepX = width / Math.max(values.length - 1, 1);

    const points = values
      .map((v, i) => (v === null || v === undefined ? null : { x: i * stepX, y: padTop + (1 - (v - min) / range) * plotHeight }))
      .filter(Boolean);

    // Gradient fill under the line to make the trend easier to read at a glance.
    const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + plotHeight);
    gradient.addColorStop(0, 'rgba(34,197,94,0.35)');
    gradient.addColorStop(1, 'rgba(34,197,94,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(points[0].x, padTop + plotHeight);
    points.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, padTop + plotHeight);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const x = i * stepX;
      const y = padTop + (1 - (v - min) / range) * plotHeight;
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();

    values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const x = i * stepX;
      const y = padTop + (1 - (v - min) / range) * plotHeight;
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(labels[i], x, height - 4);
    });
  }

  // ---------- Export / Import / Reset ----------
  document.getElementById('btn-export').addEventListener('click', () => {
    downloadBackup('suivi-trail-backup.json');
    const settings = getAutoBackupSettings();
    settings.lastDate = new Date().toISOString().slice(0, 10);
    setAutoBackupSettings(settings);
    updateAutoBackupStatus();
  });

  const chkAutoBackup = document.getElementById('chk-auto-backup');
  chkAutoBackup.checked = getAutoBackupSettings().enabled;
  chkAutoBackup.addEventListener('change', () => {
    const settings = getAutoBackupSettings();
    settings.enabled = chkAutoBackup.checked;
    setAutoBackupSettings(settings);
    if (settings.enabled) maybeAutoBackup();
    updateAutoBackupStatus();
  });
  updateAutoBackupStatus();

  document.getElementById('input-import').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.plans) || !Array.isArray(parsed.results)) {
          throw new Error('Format invalide');
        }
        if (confirm('Importer ces données remplacera les données actuelles. Continuer ?')) {
          data = parsed;
          saveData();
          renderAll();
          alert('Import réussi.');
        }
      } catch (err) {
        alert('Fichier invalide : ' + err.message);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm('Cette action supprime définitivement toutes les données. Continuer ?')) {
      data = { plans: [], results: [] };
      saveData();
      renderAll();
    }
  });

  function renderAll() {
    renderPlanning();
    renderResultForm();
    renderResults();
    renderStats();
  }

  renderAll();
})();
