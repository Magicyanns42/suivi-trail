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
  const tabButtons = document.querySelectorAll('nav.tabs button');
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabButtons.forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
      // Canvas charts need the tab visible (non-zero width) to size correctly.
      if (btn.dataset.tab === 'tab-stats') renderEvolutionCharts();
    });
  });

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
  let editingPlanId = null;

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
    formPlan.scrollIntoView({ behavior: 'smooth' });
  }

  function cancelEditPlan() {
    editingPlanId = null;
    formPlan.reset();
    formPlan.querySelector('select[name="reminderHours"]').value = '24';
    formPlanTitle.textContent = '➕ Planifier une sortie';
    btnSubmitPlan.textContent = 'Ajouter au planning';
    btnCancelEditPlan.style.display = 'none';
  }

  btnCancelEditPlan.addEventListener('click', cancelEditPlan);

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
          tabButtons.forEach((b) => b.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
          document.querySelector('[data-tab="tab-results"]').classList.add('active');
          document.getElementById('tab-results').classList.add('active');
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
          tabButtons.forEach((b) => b.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
          document.querySelector('[data-tab="tab-planning"]').classList.add('active');
          document.getElementById('tab-planning').classList.add('active');
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
    };
  }

  document.getElementById('input-gpx').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseGpx(reader.result);
        formResult.querySelector('[name="plannedId"]').value = '';
        formResult.querySelector('[name="name"]').value = parsed.name || file.name.replace(/\.gpx$/i, '');
        if (parsed.date) formResult.querySelector('[name="date"]').value = parsed.date;
        if (parsed.distanceKm) formResult.querySelector('[name="distanceKm"]').value = parsed.distanceKm;
        if (parsed.deniveleM) formResult.querySelector('[name="deniveleM"]').value = parsed.deniveleM;
        if (parsed.temps) formResult.querySelector('[name="temps"]').value = parsed.temps;
        formResult.scrollIntoView({ behavior: 'smooth' });
        alert('Données importées : vérifie les champs puis complète le ressenti avant d\'enregistrer.');
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
    const result = {
      id: uid(),
      plannedId: fd.get('plannedId') || null,
      name: fd.get('name').trim(),
      date: fd.get('date'),
      distanceKm: fd.get('distanceKm') ? Number(fd.get('distanceKm')) : null,
      deniveleM: fd.get('deniveleM') ? Number(fd.get('deniveleM')) : null,
      temps: fd.get('temps').trim() || null,
      ressenti: Number(fd.get('ressenti')),
      notes: fd.get('notes').trim(),
    };
    data.results.push(result);
    if (result.plannedId) {
      const plan = data.plans.find((p) => p.id === result.plannedId);
      if (plan) plan.done = true;
    }
    saveData();
    formResult.reset();
    formResult.querySelector('[name="ressenti"]').value = '3';
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
            <button class="secondary small btn-share">📤</button>
            <button class="danger small btn-del">🗑</button>
          </div>
        </div>
        ${r.notes ? `<div class="item-notes">${escapeHtml(r.notes)}</div>` : ''}
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
        if (result) shareResult(result);
      });
    });
  }

  // ---------- Partage résultat ----------
  function buildResultShareImage(result) {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 450;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText('🏔️ Suivi Trail', 32, 50);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 34px system-ui, sans-serif';
    wrapText(ctx, result.name, 32, 110, 736, 40);

    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(formatDate(result.date), 32, 155);

    const pace = formatPace(result.distanceKm, result.temps);
    const stats = [
      result.distanceKm ? [`${result.distanceKm} km`, 'Distance'] : null,
      result.deniveleM ? [`${Math.round(result.deniveleM)} m`, 'D+'] : null,
      result.temps ? [result.temps, 'Temps'] : null,
      pace ? [pace, 'Allure'] : null,
    ].filter(Boolean);

    const boxWidth = 736 / Math.max(stats.length, 1);
    stats.forEach((s, i) => {
      const x = 32 + i * boxWidth;
      ctx.fillStyle = 'rgba(34,197,94,0.12)';
      ctx.fillRect(x, 200, boxWidth - 12, 100);
      ctx.fillStyle = '#22c55e';
      ctx.font = 'bold 26px system-ui, sans-serif';
      ctx.fillText(s[0], x + 12, 245);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText(s[1], x + 12, 275);
    });

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText(RESSENTI_LABELS[result.ressenti] || '', 32, 350);

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

  async function shareResult(result) {
    const blob = await buildResultShareImage(result);
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

  function setupCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const cssWidth = canvas.clientWidth || 600;
    const cssHeight = 140;
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
