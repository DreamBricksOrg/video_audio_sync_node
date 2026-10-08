document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();

    const totemGrid = document.getElementById('totemGrid');
    const addTotemBtn = document.getElementById('addTotemBtn');
    
    // Modal elements
    const qrModal = document.getElementById('qrModal');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const modalTitle = document.getElementById('modalTitle');
    const qrcodeContainer = document.getElementById('qrcode');
    const qrUrlText = document.getElementById('qrUrl');
    const openLinkBtn = document.getElementById('openLinkBtn');

    let videosCache = [];
    let audiosCache = [];
    let qrCodeInstance = null;

    // Media library elements
    const mediaInput = document.getElementById('mediaInput');
    const dropZone = document.getElementById('dropZone');
    const uploadList = document.getElementById('uploadList');
    const videoList = document.getElementById('videoList');
    const audioList = document.getElementById('audioList');

    const replaceInput = document.getElementById('replaceInput');

    const MEDIA_EXTS = ['.mp4', '.webm', '.mp3', '.wav', '.ogg'];
    let mediaCache = [];
    let mediaError = null; // e.g. the S3 bucket could not be listed
    let totemsById = {};

    // Session expired / logged out elsewhere → back to the login screen
    function redirectToLogin() {
        location.replace(`/login?next=${encodeURIComponent('/admin')}`);
    }

    async function api(url, options) {
        const res = await fetch(url, options);
        if (res.status === 401) {
            redirectToLogin();
            throw new Error('Sessão expirada');
        }
        return res;
    }

    async function init() {
        await loadSession();
        showView();
        await fetchMedia();
        await fetchTotems();
        // Poll for statuses
        setInterval(fetchTotems, 5000);
        loadStats();
        setInterval(loadStats, 60000);
    }

    // Who is logged in; Admin-only parts (users, activity log, other sessions)
    // stay hidden for editors — the server refuses them anyway
    let currentUser = { user: '', role: '' };
    async function loadSession() {
        try {
            const res = await api('/api/session');
            currentUser = await res.json();
            const label = `${currentUser.user} · ${currentUser.role === 'admin' ? 'Admin' : 'Editor'}`;
            document.getElementById('currentUser').textContent = label;
            document.getElementById('menuUser').textContent = label;
        } catch (_) {}
        const isAdmin = currentUser.role === 'admin';
        document.querySelectorAll('.admin-only').forEach(el => { el.hidden = !isAdmin; });
        if (isAdmin) loadSessionCount();
    }

    // ── Sections (tabs): one area at a time, chosen by the address (#midia…)
    // so a reload or a saved link opens the same tab ──
    const VIEWS = ['campanhas', 'midia', 'estatisticas', 'usuarios', 'atividades'];
    const ADMIN_VIEWS = ['usuarios', 'atividades'];
    function showView() {
        let view = location.hash.slice(1);
        if (!VIEWS.includes(view) || (ADMIN_VIEWS.includes(view) && currentUser.role !== 'admin')) view = 'campanhas';
        document.querySelectorAll('.view').forEach(el => { el.hidden = el.dataset.view !== view; });
        document.querySelectorAll('.nav-tab').forEach(tab => {
            const active = tab.dataset.view === view;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active);
        });
        // Fresh data when entering a tab (the chart also needs to be visible to lay out)
        if (view === 'estatisticas') loadStats();
        if (view === 'usuarios') loadUsers();
        if (view === 'atividades') loadAudit();
    }
    window.addEventListener('hashchange', showView);

    // ── Small screens: hamburger menu with the tabs and the account actions ──
    const menuToggle = document.getElementById('menuToggle');
    const adminNav = document.getElementById('adminNav');
    function setMenu(open) {
        adminNav.classList.toggle('open', open);
        menuToggle.setAttribute('aria-expanded', open);
        menuToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
        menuToggle.innerHTML = `<i data-lucide="${open ? 'x' : 'menu'}"></i>`;
        lucide.createIcons();
    }
    menuToggle.addEventListener('click', () => setMenu(!adminNav.classList.contains('open')));
    adminNav.addEventListener('click', e => { if (e.target.closest('.nav-tab')) setMenu(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && adminNav.classList.contains('open')) setMenu(false); });
    document.getElementById('menuLogout').addEventListener('click', () => document.getElementById('logoutBtn').click());
    document.getElementById('menuRevoke').addEventListener('click', () => {
        setMenu(false);
        document.getElementById('revokeOthersBtn').click();
    });

    // "Desconectar outros aparelhos" only shows when another browser is logged in
    const revokeOthersBtn = document.getElementById('revokeOthersBtn');
    async function loadSessionCount() {
        try {
            const { count } = await (await api('/api/sessions')).json();
            const others = count - 1;
            revokeOthersBtn.hidden = others < 1;
            document.getElementById('menuRevoke').hidden = others < 1;
            document.getElementById('revokeOthersLabel').textContent =
                `Desconectar outros aparelhos (${others})`;
        } catch (_) {}
    }

    revokeOthersBtn.addEventListener('click', async () => {
        if (!confirm('Encerrar o login em todos os outros navegadores e aparelhos?\n\nEste navegador continua conectado.')) return;
        try {
            const res = await api('/api/sessions/revoke-others', { method: 'POST' });
            const body = await res.json();
            if (!res.ok) return alert(body.error || `Não foi possível desconectar (${res.status})`);
            alert(body.revoked === 1 ? '1 aparelho foi desconectado.' : `${body.revoked} aparelhos foram desconectados.`);
        } catch (_) {
            alert('Não foi possível desconectar os outros aparelhos.');
        }
        loadSessionCount();
    });

    document.getElementById('logoutBtn').addEventListener('click', async () => {
        try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
        location.replace('/login');
    });

    async function fetchMedia() {
        try {
            const res = await api('/api/media');
            const body = await res.json();
            if (!res.ok) {
                mediaError = body.error || `Erro ao listar os arquivos (${res.status})`;
                renderMedia();
                return;
            }
            mediaError = null;
            mediaCache = body;
            videosCache = mediaCache.filter(m => m.type === 'video').map(m => m.filename);
            audiosCache = mediaCache.filter(m => m.type === 'audio').map(m => m.filename);
            renderMedia();
        } catch (e) {
            console.error('Failed to fetch media', e);
        }
    }

    async function fetchTotems() {
        try {
            const res = await api('/api/totems');
            const totems = await res.json();
            renderTotems(totems);
        } catch (e) {
            console.error('Failed to fetch totems', e);
        }
    }

    // ── Pagination: every list shows one page at a time, with a pager below.
    // The page is kept per list (the 5s refresh of the cards doesn't reset it).
    const currentPages = {}; // list name → page (1-based)
    function pageOf(name, items, size) {
        const pages = Math.max(1, Math.ceil(items.length / size));
        const page = Math.min(Math.max(currentPages[name] || 1, 1), pages);
        currentPages[name] = page;
        const start = (page - 1) * size;
        return { items: items.slice(start, start + size), page, pages, total: items.length, from: start + 1, to: Math.min(start + size, items.length) };
    }

    // Draws "‹ 11–20 de 47 ›" into <nav id="pager-NAME">; hidden when one page is enough
    function renderPager(name, info, onChange) {
        const el = document.getElementById(`pager-${name}`);
        if (!el) return;
        el.hidden = info.pages <= 1;
        if (el.hidden) { el.innerHTML = ''; return; }
        el.innerHTML = `
            <button type="button" class="icon-btn" data-page="${info.page - 1}" ${info.page === 1 ? 'disabled' : ''} aria-label="Página anterior"><i data-lucide="chevron-left"></i></button>
            <span class="pager-info">${info.from}–${info.to} de ${info.total}</span>
            <button type="button" class="icon-btn" data-page="${info.page + 1}" ${info.page === info.pages ? 'disabled' : ''} aria-label="Próxima página"><i data-lucide="chevron-right"></i></button>`;
        el.onclick = e => {
            const btn = e.target.closest('[data-page]');
            if (!btn || btn.disabled) return;
            currentPages[name] = Number(btn.dataset.page);
            onChange();
        };
        lucide.createIcons();
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function mediaOptions(files, selected, placeholder) {
        // Keep a configured file visible even if it was removed from the library
        const list = selected && !files.includes(selected) ? [selected, ...files] : files;
        return `<option value="">${placeholder}</option>` + list.map(f =>
            `<option value="${escapeHtml(f)}" ${f === selected ? 'selected' : ''}>${escapeHtml(f)}</option>`
        ).join('');
    }

    // Re-rendering every poll would wipe unsaved select changes, so only rebuild
    // the cards when something other than live status changed.
    let totemsSignature = '';
    let lastTotems = [];
    const TOTEMS_PER_PAGE = 12;

    // ── Search and filter of the campaign cards ──
    const campaignSearch = document.getElementById('campaignSearch');
    const campaignFilter = document.getElementById('campaignFilter');
    // Lowercase without accents, so "promoção" matches "promocao"
    const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const CAMPAIGN_FILTERS = {
        online: t => t.is_online,
        offline: t => !t.is_online,
        playlist: t => (t.playlist || []).length > 1,
        scheduled: t => !!t.schedule,
        'off-air': t => t.configured && t.showing !== t.id,
        problem: t => (t.missing || []).length > 0,
        unsaved: t => !t.configured,
    };
    function matchesCampaign(t) {
        const filter = CAMPAIGN_FILTERS[campaignFilter.value];
        if (filter && !filter(t)) return false;
        const words = fold(campaignSearch.value).split(/\s+/).filter(Boolean);
        if (!words.length) return true;
        const text = fold([t.id, t.video, t.audio, ...(t.playlist || []).flatMap(i => [i.video, i.audio])].join(' '));
        return words.every(w => text.includes(w));
    }
    function refilterCampaigns() {
        currentPages.totems = 1;
        totemsSignature = '';
        renderTotems(lastTotems);
    }
    let searchTimer = null;
    campaignSearch.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refilterCampaigns, 150);
    });
    campaignFilter.addEventListener('change', refilterCampaigns);

    function renderTotems(totems) {
        totemsById = Object.fromEntries(totems.map(t => [t.id, t]));
        lastTotems = totems;
        const shown = totems.filter(matchesCampaign);
        const filtering = !!(campaignSearch.value.trim() || campaignFilter.value);
        const page = pageOf('totems', shown, TOTEMS_PER_PAGE);

        const signature = JSON.stringify([
            page.page, campaignSearch.value, campaignFilter.value,
            // Live status only matters for the card list when filtering by it
            ['online', 'offline'].includes(campaignFilter.value) ? totems.map(t => t.is_online) : null,
            totems.map(t => [t.id, t.configured, t.video, t.audio, t.missing, t.playlist, t.schedule, t.showing]),
            videosCache, audiosCache,
        ]);
        if (signature === totemsSignature) {
            totems.forEach(updateTotemStatus);
            return;
        }
        totemsSignature = signature;

        const n = totems.length;
        document.getElementById('campaignCount').textContent = filtering
            ? `${shown.length} de ${n} ${n === 1 ? 'campanha' : 'campanhas'}`
            : `${n} ${n === 1 ? 'campanha' : 'campanhas'}`;

        totemGrid.innerHTML = '';
        renderPager('totems', page, () => {
            totemsSignature = '';
            renderTotems(lastTotems);
            totemGrid.scrollIntoView({ block: 'start' });
        });
        if (totems.length === 0) {
            totemGrid.innerHTML = '<div class="empty-state">Nenhuma campanha cadastrada ainda. Clique em "Adicionar campanha" para começar.</div>';
            return;
        }
        if (shown.length === 0) {
            totemGrid.innerHTML = `<div class="empty-state">Nenhuma campanha encontrada com essa busca/filtro.
                <button type="button" class="btn btn-ghost btn-sm" id="clearCampaignFilters">Limpar busca e filtro</button></div>`;
            document.getElementById('clearCampaignFilters').addEventListener('click', () => {
                campaignSearch.value = '';
                campaignFilter.value = '';
                refilterCampaigns();
            });
            return;
        }

        page.items.forEach(totem => {
            const card = document.createElement('div');
            card.className = 'totem-card';
            card.dataset.id = totem.id;
            const id = escapeHtml(totem.id);
            // 2+ videos: the card lists them and edits in the modal
            const isList = (totem.playlist || []).length > 1;

            card.innerHTML = `
                <div class="card-header">
                    <div class="totem-id">${id}</div>
                    <div class="card-header-actions">
                        <div class="status-pill"><span class="dot"></span><span class="status-label"></span></div>
                        ${totem.configured ? `
                        <button type="button" class="icon-btn embed-btn" title="Incorporar em um site" aria-label="Incorporar ${id}"><i data-lucide="code"></i></button>
                        <button type="button" class="icon-btn edit-btn" title="Editar campanha" aria-label="Editar ${id}"><i data-lucide="pencil"></i></button>
                        <button type="button" class="icon-btn danger delete-btn" title="Excluir totem" aria-label="Excluir ${id}"><i data-lucide="trash-2"></i></button>
                        ` : ''}
                    </div>
                </div>
                ${totem.configured ? '' : `
                <p class="card-note"><i data-lucide="info"></i> Ligado, mas ainda não salvo. Escolha o vídeo e o áudio e clique em Aplicar.</p>`}
                ${(totem.missing || []).length ? `
                <p class="card-note card-note-danger"><i data-lucide="alert-triangle"></i>
                    <span>Arquivo não encontrado na biblioteca: <strong>${totem.missing.map(escapeHtml).join(', ')}</strong>.
                    As telas não vão conseguir tocar. Escolha outro arquivo e clique em Aplicar.</span></p>` : ''}
                <div class="card-metrics">
                    <div class="metric">
                        <span class="metric-label">Telas abertas</span>
                        <span class="metric-value instance-count"></span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Celulares ouvindo</span>
                        <span class="metric-value mobile-count"></span>
                    </div>
                </div>
                ${scheduleNote(totem)}
                ${isList ? `
                <div class="card-fields">
                    <span class="form-label">Vídeos, em ordem</span>
                    <ol class="card-playlist">${totem.playlist.map(i =>
                        `<li>${escapeHtml(i.video)}${i.audio ? ` + ${escapeHtml(i.audio)}` : ' (sem áudio)'}</li>`).join('')}</ol>
                </div>` : `
                <div class="card-fields">
                    <label class="form-group">
                        <span class="form-label">Vídeo atual</span>
                        <select class="custom-select video-select">${mediaOptions(videosCache, totem.video, '-- Escolha um vídeo --')}</select>
                    </label>
                    <label class="form-group">
                        <span class="form-label">Áudio atual (celular)</span>
                        <select class="custom-select audio-select">${mediaOptions(audiosCache, totem.audio, '-- Escolha um áudio --')}</select>
                    </label>
                </div>`}
                <div class="card-actions">
                    ${isList
                        ? '<button class="btn btn-primary list-btn"><i data-lucide="list-video"></i> Editar</button>'
                        : '<button class="btn btn-primary assign-btn"><i data-lucide="save"></i> Aplicar</button>'}
                    <button class="btn btn-secondary link-btn"><i data-lucide="smartphone"></i> Celular</button>
                    <button class="btn btn-secondary promo-btn"><i data-lucide="link"></i> Links</button>
                </div>
            `;

            if (isList) card.querySelector('.list-btn').addEventListener('click', () => openTotemEditor(totem.id));
            else card.querySelector('.assign-btn').addEventListener('click', () => handleAssignConfig(totem.id, card));
            card.querySelector('.link-btn').addEventListener('click', () => handleGenerateLink(totem.id));
            card.querySelector('.promo-btn').addEventListener('click', () => openPromoEditor(totem.id));
            if (totem.configured) {
                card.querySelector('.embed-btn').addEventListener('click', () => openEmbedEditor(totem.id));
                card.querySelector('.edit-btn').addEventListener('click', () => openTotemEditor(totem.id));
                card.querySelector('.delete-btn').addEventListener('click', () => deleteTotem(totem.id));
            }

            totemGrid.appendChild(card);
            updateTotemStatus(totem);
        });

        lucide.createIcons();
    }

    // Period on air: what the campaign shows now and until when
    function scheduleNote(totem) {
        const s = totem.schedule;
        if (!s) return '';
        const fmt = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const now = Date.now();
        const showingNow = totem.showing === totem.id ? 'esta campanha'
            : totem.showing ? `a campanha ${escapeHtml(totem.showing)}` : 'tela preta com o logo';
        let when;
        if (s.start && now < Date.parse(s.start)) when = `Começa em ${fmt(s.start)}`;
        else if (s.end && now >= Date.parse(s.end)) when = `Terminou em ${fmt(s.end)}`;
        else when = s.end ? `No ar até ${fmt(s.end)}` : `No ar desde ${fmt(s.start)}`;
        const danger = totem.showing !== totem.id;
        return `<p class="card-note ${danger ? '' : 'card-note-info'} schedule-note"><i data-lucide="calendar-clock"></i>
            <span>${when}. Agora: <strong>${showingNow}</strong>.</span></p>`;
    }

    function updateTotemStatus(totem) {
        const card = [...totemGrid.children].find(c => c.dataset.id === totem.id);
        if (!card) return;
        const pill = card.querySelector('.status-pill');
        pill.classList.toggle('online', totem.is_online);
        pill.classList.toggle('offline', !totem.is_online);
        pill.querySelector('.status-label').textContent = totem.is_online ? 'Ao vivo' : 'Desligado';
        card.querySelector('.mobile-count').textContent = totem.mobile_count;
        card.querySelector('.instance-count').textContent = totem.instances;
    }

    async function handleAssignConfig(totemId, card) {
        const video = card.querySelector('.video-select').value;
        const audio = card.querySelector('.audio-select').value;

        if (!video || !audio) return alert("Escolha um vídeo e um áudio.");

        try {
            const res = await api(`/api/totem/${encodeURIComponent(totemId)}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ video, audio })
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                return alert(body.error || `Não foi possível salvar (${res.status})`);
            }
            const btn = card.querySelector('.assign-btn');
            btn.innerHTML = '<i data-lucide="check"></i> Salvo';
            lucide.createIcons();
            setTimeout(refreshAll, 1200); // refresh "in use" markers and the card
        } catch (e) {
            console.error('Failed to assign video', e);
            alert("Erro ao salvar a configuração.");
        }
    }

    async function deleteTotem(totemId) {
        if (!confirm(`Excluir a campanha "${totemId}"?\n\nO vídeo, o áudio e os links do celular configurados nele serão apagados.`)) return;
        try {
            const res = await api(`/api/totem/${encodeURIComponent(totemId)}`, { method: 'DELETE' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return alert(body.error || `Não foi possível excluir (${res.status})`);
            if (body.still_online) {
                alert(`"${totemId}" foi excluído, mas a tela dele ainda está conectada. Ele vai aparecer como "não salvo" até essa tela ser fechada.`);
            }
            await refreshAll();
        } catch (e) {
            console.error('Delete totem failed', e);
        }
    }

    // ── Totem create / edit modal ──────────────────────
    const totemModal = document.getElementById('totemModal');
    const totemForm = document.getElementById('totemForm');
    const totemModalTitle = document.getElementById('totemModalTitle');
    const totemIdInput = document.getElementById('totemIdInput');
    const playlistRows = document.getElementById('playlistRows');
    const totemStart = document.getElementById('totemStart');
    const totemEnd = document.getElementById('totemEnd');
    const totemFallback = document.getElementById('totemFallback');
    const totemUrlHint = document.getElementById('totemUrlHint');
    const totemRenameWarning = document.getElementById('totemRenameWarning');
    const totemError = document.getElementById('totemError');
    const totemSaveBtn = document.getElementById('totemSaveBtn');
    let editingTotemId = null; // null = creating

    function showTotemError(msg) {
        totemError.textContent = msg;
        totemError.hidden = !msg;
    }

    function updateTotemUrlHint() {
        const id = totemIdInput.value.trim() || '<ID>';
        totemUrlHint.textContent = `${location.origin}/static/totem.html?screen=${id}`;
        const renaming = editingTotemId && totemIdInput.value.trim() !== editingTotemId;
        totemRenameWarning.hidden = !renaming;
    }

    function openTotemEditor(totemId = null) {
        editingTotemId = totemId;
        const totem = totemId ? totemsById[totemId] : null;
        totemModalTitle.textContent = totemId ? `Editar campanha — ${totemId}` : 'Adicionar campanha';
        totemSaveBtn.textContent = totemId ? 'Salvar' : 'Criar campanha';
        totemIdInput.value = totemId || '';
        playlistRows.innerHTML = '';
        const items = totem ? totem.playlist : [{ video: videosCache[0] || '', audio: audiosCache[0] || '' }];
        (items.length ? items : [{ video: '', audio: '' }]).forEach(addPlaylistRow);
        const schedule = (totem && totem.schedule) || {};
        totemStart.value = toLocalInput(schedule.start);
        totemEnd.value = toLocalInput(schedule.end);
        const others = Object.keys(totemsById).filter(id => id !== totemId && totemsById[id].configured).sort();
        totemFallback.innerHTML = '<option value="">Tela preta com o logo</option>' +
            others.map(id => `<option value="${escapeHtml(id)}">A campanha ${escapeHtml(id)}</option>`).join('');
        totemFallback.value = schedule.fallback && others.includes(schedule.fallback) ? schedule.fallback : '';
        showTotemError('');
        updateTotemUrlHint();
        totemModal.classList.remove('fade-out');
        totemIdInput.focus();
    }

    // ── Playlist rows: video + its audio, reorderable ──
    function addPlaylistRow(item = { video: '', audio: '' }) {
        const li = document.createElement('li');
        li.className = 'playlist-row';
        li.innerHTML = `
            <span class="row-num"></span>
            <select class="custom-select pl-video" aria-label="Vídeo">${mediaOptions(videosCache, item.video, '-- Vídeo --')}</select>
            <select class="custom-select pl-audio" aria-label="Áudio no celular">${mediaOptions(audiosCache, item.audio, '-- Sem áudio --')}</select>
            <span class="row-actions">
                <button type="button" class="icon-btn" data-move="-1" title="Subir" aria-label="Subir"><i data-lucide="arrow-up"></i></button>
                <button type="button" class="icon-btn" data-move="1" title="Descer" aria-label="Descer"><i data-lucide="arrow-down"></i></button>
                <button type="button" class="icon-btn danger" data-remove title="Tirar da lista" aria-label="Tirar da lista"><i data-lucide="x"></i></button>
            </span>`;
        li.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => {
            const sibling = btn.dataset.move === '-1' ? li.previousElementSibling : li.nextElementSibling;
            if (!sibling) return;
            if (btn.dataset.move === '-1') playlistRows.insertBefore(li, sibling);
            else playlistRows.insertBefore(sibling, li);
            numberPlaylistRows();
        }));
        li.querySelector('[data-remove]').addEventListener('click', () => {
            li.remove();
            numberPlaylistRows();
        });
        playlistRows.appendChild(li);
        numberPlaylistRows();
        lucide.createIcons();
    }

    function numberPlaylistRows() {
        const rows = [...playlistRows.children];
        rows.forEach((li, i) => {
            li.querySelector('.row-num').textContent = `${i + 1}.`;
            li.querySelector('[data-move="-1"]').disabled = i === 0;
            li.querySelector('[data-move="1"]').disabled = i === rows.length - 1;
            li.querySelector('[data-remove]').disabled = rows.length === 1;
        });
    }

    document.getElementById('addPlaylistRow').addEventListener('click', () => addPlaylistRow());

    // <input type="datetime-local"> works in the browser's time zone; the server keeps UTC
    function toLocalInput(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    const fromLocalInput = value => (value ? new Date(value).toISOString() : null);

    function closeTotemEditor() {
        totemModal.classList.add('fade-out');
        editingTotemId = null;
    }

    totemIdInput.addEventListener('input', updateTotemUrlHint);
    totemModal.querySelectorAll('[data-close-totem]').forEach(btn => btn.addEventListener('click', closeTotemEditor));
    totemModal.addEventListener('click', (e) => { if (e.target === totemModal) closeTotemEditor(); });

    totemForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const rows = [...playlistRows.children].map(li => ({
            video: li.querySelector('.pl-video').value,
            audio: li.querySelector('.pl-audio').value,
        }));
        const start = fromLocalInput(totemStart.value);
        const end = fromLocalInput(totemEnd.value);
        const fallback = totemFallback.value || null;
        const payload = {
            id: totemIdInput.value.trim(),
            // A single empty row = no video yet
            playlist: rows.length === 1 && !rows[0].video && !rows[0].audio ? [] : rows,
            schedule: start || end || fallback ? { start, end, fallback } : null,
        };
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(payload.id)) {
            return showTotemError('O ID deve ter de 1 a 40 letras, números, - ou _ (sem espaços).');
        }
        if (payload.playlist.some(i => !i.video)) {
            return showTotemError('Escolha o vídeo de cada item da lista (ou tire o item).');
        }

        showTotemError('');
        totemSaveBtn.disabled = true;
        try {
            const res = editingTotemId
                ? await api(`/api/totem/${encodeURIComponent(editingTotemId)}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
                })
                : await api('/api/totems', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
                });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return showTotemError(body.error || `Não foi possível salvar (${res.status})`);
            closeTotemEditor();
            await refreshAll();
        } catch (err) {
            showTotemError('Não foi possível falar com o servidor.');
        } finally {
            totemSaveBtn.disabled = false;
        }
    });

    function handleGenerateLink(totemId) {
        const url = `${window.location.origin}/static/mobile.html?screen=${encodeURIComponent(totemId)}`;
        modalTitle.innerText = `Link do celular — ${totemId}`;
        qrUrlText.innerText = url;
        openLinkBtn.href = url;

        qrcodeContainer.innerHTML = '';
        qrCodeInstance = new QRCode(qrcodeContainer, {
            text: url,
            width: 200,
            height: 200,
            colorDark : "#034a5d", // --db-blue-900
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.H
        });

        qrModal.classList.remove('fade-out');
    }

    // ── Media library ──────────────────────────────────
    const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

    function iconButton(icon, label, extraClass = '') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `icon-btn ${extraClass}`.trim();
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.innerHTML = `<i data-lucide="${icon}"></i>`;
        return btn;
    }

    function renderMediaRow(item) {
        const li = document.createElement('li');

        const info = document.createElement('div');
        info.className = 'media-info';
        const name = document.createElement('span');
        name.className = 'media-name';
        name.textContent = item.filename;
        const meta = document.createElement('span');
        meta.className = 'media-meta';
        meta.textContent = `${formatSize(item.size)} · ${dateFormat.format(new Date(item.modified))}`;
        if (item.used_by.length) {
            const badge = document.createElement('span');
            badge.className = 'in-use';
            // Long lists stay one line: the first two + "e mais N"; all of them on hover
            const shown = item.used_by.slice(0, 2).join(', ');
            const more = item.used_by.length - 2;
            badge.textContent = `Em uso: ${shown}${more > 0 ? ` e mais ${more}` : ''}`;
            badge.title = `Em uso por: ${item.used_by.join(', ')}`;
            meta.appendChild(badge);
        }
        info.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'media-actions';

        const preview = document.createElement('a');
        preview.className = 'icon-btn';
        preview.href = `/media/${encodeURIComponent(item.filename)}`;
        preview.target = '_blank';
        preview.rel = 'noopener';
        preview.title = 'Ver / baixar';
        preview.setAttribute('aria-label', `Ver ${item.filename}`);
        preview.innerHTML = '<i data-lucide="play"></i>';

        const rename = iconButton('pencil', `Renomear ${item.filename}`);
        rename.addEventListener('click', () => renameMedia(item));

        const replace = iconButton('replace', `Substituir ${item.filename}`);
        replace.addEventListener('click', () => pickReplacement(item));

        const del = iconButton('trash-2', `Excluir ${item.filename}`, 'danger');
        if (item.used_by.length) {
            del.disabled = true;
            del.title = `Em uso por ${item.used_by.join(', ')} — troque o arquivo do totem antes`;
        }
        del.addEventListener('click', () => deleteMedia(item));

        actions.append(preview, rename, replace, del);
        li.append(info, actions);
        return li;
    }

    const MEDIA_PER_PAGE = 10;
    function renderMediaList(listEl, countEl, items, name) {
        listEl.innerHTML = '';
        document.getElementById(countEl).textContent = items.length;
        const page = pageOf(name, mediaError ? [] : items, MEDIA_PER_PAGE);
        renderPager(name, page, renderMedia);
        if (mediaError || items.length === 0) {
            const li = document.createElement('li');
            li.className = mediaError ? 'empty media-error' : 'empty';
            li.textContent = mediaError || 'Nenhum arquivo ainda.';
            listEl.appendChild(li);
            return;
        }
        page.items.forEach(item => listEl.appendChild(renderMediaRow(item)));
    }

    function renderMedia() {
        renderMediaList(videoList, 'videoCount', mediaCache.filter(m => m.type === 'video'), 'videos');
        renderMediaList(audioList, 'audioCount', mediaCache.filter(m => m.type === 'audio'), 'audios');
        lucide.createIcons();
    }

    async function refreshAll() {
        await fetchMedia();
        await fetchTotems();
    }

    async function renameMedia(item) {
        const dot = item.filename.lastIndexOf('.');
        const ext = item.filename.slice(dot);
        const input = prompt(`Novo nome para "${item.filename}":`, item.filename.slice(0, dot));
        if (input === null) return;
        const trimmed = input.trim();
        if (!trimmed) return;
        // Keep the current extension unless the user typed one
        const newName = MEDIA_EXTS.some(e => trimmed.toLowerCase().endsWith(e)) ? trimmed : trimmed + ext;

        try {
            const res = await api(`/api/media/${encodeURIComponent(item.filename)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: newName }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return alert(body.error || `Não foi possível renomear (${res.status})`);
            await refreshAll();
        } catch (e) {
            console.error('Rename failed', e);
        }
    }

    let replaceTarget = null;

    function pickReplacement(item) {
        replaceTarget = item;
        replaceInput.accept = item.filename.slice(item.filename.lastIndexOf('.'));
        replaceInput.click();
    }

    replaceInput.addEventListener('change', async () => {
        const file = replaceInput.files[0];
        replaceInput.value = '';
        const target = replaceTarget;
        replaceTarget = null;
        if (!file || !target) return;

        const targetExt = target.filename.slice(target.filename.lastIndexOf('.')).toLowerCase();
        const fileExt = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        if (fileExt !== targetExt) {
            return alert(`"${target.filename}" só pode ser substituído por outro arquivo ${targetExt}.`);
        }
        if (!confirm(`Substituir o conteúdo de "${target.filename}" por "${file.name}"?`)) return;

        const item = createUploadItem(file);
        try {
            const res = (await sendDirect(file, { replace: target.filename }, item.progress)) ||
                await sendFile(file, {
                    method: 'PUT',
                    url: `/api/media/${encodeURIComponent(target.filename)}`,
                }, item.progress);
            if (res.status === 200 || res.status === 201) item.done(`${res.body.filename} substituído`);
            else item.error(res.body.error || `Não foi possível substituir (${res.status})`);
        } catch (e) {
            item.error(e.message);
        }
        await refreshAll();
    });

    async function deleteMedia(item) {
        if (!confirm(`Excluir "${item.filename}" do servidor? Não dá para desfazer.`)) return;
        try {
            const res = await api(`/api/media/${encodeURIComponent(item.filename)}`, { method: 'DELETE' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                const who = body.used_by ? ` (${body.used_by.join(', ')})` : '';
                return alert((body.error || `Não foi possível excluir (${res.status})`) + who);
            }
            await refreshAll();
        } catch (e) {
            console.error('Delete failed', e);
        }
    }

    function formatSize(bytes) {
        return bytes >= 1024 * 1024
            ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
            : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    function createUploadItem(file) {
        const li = document.createElement('li');
        li.className = 'upload-item';
        li.innerHTML = `
            <span class="upload-name"></span>
            <span class="upload-status">Aguardando…</span>
            <div class="progress"><div class="progress-bar"></div></div>
        `;
        li.querySelector('.upload-name').textContent = `${file.name} · ${formatSize(file.size)}`;
        uploadList.prepend(li);
        return {
            progress: pct => {
                li.querySelector('.progress-bar').style.width = `${pct}%`;
                li.querySelector('.upload-status').textContent = `${pct}%`;
            },
            status: msg => {
                li.querySelector('.upload-status').textContent = msg;
            },
            done: msg => {
                li.classList.add('done');
                li.querySelector('.progress-bar').style.width = '100%';
                li.querySelector('.upload-status').textContent = msg;
                setTimeout(() => li.remove(), 5000);
            },
            error: msg => {
                li.classList.add('error');
                li.querySelector('.upload-status').textContent = msg;
            },
        };
    }


    // XHR (not fetch) so we get upload progress events
    function sendFile(file, { method, url }, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.onprogress = e => {
                if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onload = () => {
                if (xhr.status === 401) {
                    redirectToLogin();
                    return reject(new Error('Sessão expirada'));
                }
                let body = {};
                try { body = JSON.parse(xhr.responseText); } catch (_) {}
                resolve({ status: xhr.status, body });
            };
            xhr.onerror = () => reject(new Error('Erro de rede'));
            xhr.send(file);
        });
    }

    // S3 mode: the file goes straight to the bucket (short-lived URL signed by
    // the server), then the server registers it. Resolves to null when the file
    // should go through the server instead: local mode, or the bucket refused
    // the browser (CORS not set up yet).
    async function sendDirect(file, request, onProgress) {
        const res = await api('/api/media/upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...request, filename: file.name, size: file.size }),
        });
        const signed = await res.json().catch(() => ({}));
        if (!res.ok) return { status: res.status, body: signed };
        if (!signed.direct) return null;

        let status;
        try {
            status = await putToBucket(file, signed, onProgress);
        } catch (e) {
            console.warn('Direct upload to S3 failed (bucket CORS?) — sending through the server instead', e);
            return null;
        }
        if (status !== 200) return { status: 502, body: { error: `O S3 recusou o envio (${status}). Tente de novo.` } };

        const done = await api('/api/media/upload-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: signed.filename }),
        });
        return { status: done.status, body: await done.json().catch(() => ({})) };
    }

    function putToBucket(file, { url, headers }, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', url);
            Object.entries(headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
            xhr.upload.onprogress = e => {
                if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onload = () => resolve(xhr.status);
            xhr.onerror = () => reject(new Error('Erro de rede'));
            xhr.send(file);
        });
    }

    async function uploadFile(file) {
        const item = createUploadItem(file);
        const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        if (!MEDIA_EXTS.includes(ext)) {
            item.error(`Tipo não suportado (${MEDIA_EXTS.join(', ')})`);
            return;
        }

        const createUrl = overwrite =>
            `/api/media?filename=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`;

        const send = async overwrite =>
            (await sendDirect(file, { overwrite }, item.progress)) ||
            sendFile(file, { method: 'POST', url: createUrl(overwrite) }, item.progress);

        try {
            let res = await send(false);
            if (res.status === 409) {
                if (!confirm(`"${res.body.filename}" já existe no servidor. Substituir?`)) {
                    item.error('Ignorado — o arquivo já existe');
                    return;
                }
                res = await send(true);
            }
            if (res.status === 201) {
                item.done(`Salvo como ${res.body.filename}`);
            } else {
                item.error(res.body.error || `Falha no envio (${res.status})`);
            }
        } catch (e) {
            item.error(e.message);
        }
    }

    async function uploadFiles(files) {
        // Sequential: keeps bandwidth on one file at a time and confirm() prompts in order
        for (const file of files) await uploadFile(file);
        await refreshAll();
    }

    // ── Video with audio → split into <name>_video + <name>_audio.mp3 ──
    const SPLIT_EXTS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];

    async function splitFile(file) {
        const item = createUploadItem(file);
        const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        if (!SPLIT_EXTS.includes(ext)) {
            item.error(`Envie um vídeo com áudio (${SPLIT_EXTS.join(', ')})`);
            return;
        }

        const web = document.getElementById('splitWeb').checked;
        const splitUrl = overwrite =>
            `/api/media/split?filename=${encodeURIComponent(file.name)}` +
            `${overwrite ? '&overwrite=1' : ''}${web ? '&web=1' : ''}`;
        // Once the upload hits 100% the server is still separating the tracks
        const onProgress = pct => (pct < 100 ? item.progress(pct) : item.status('Separando vídeo e áudio…'));

        try {
            let res = await sendFile(file, { method: 'POST', url: splitUrl(false) }, onProgress);
            if (res.status === 409) {
                const files = (res.body.files || []).join(' e ');
                if (!confirm(`${files} já existe(m) no servidor. Substituir?`)) {
                    item.error('Ignorado — os arquivos já existem');
                    return;
                }
                res = await sendFile(file, { method: 'POST', url: splitUrl(true) }, onProgress);
            }
            if (res.status === 201) {
                item.done(`Separado: ${res.body.video} + ${res.body.audio}` +
                    (res.body.web ? ' (vídeo otimizado para sites)'
                        : res.body.transcoded ? ' (vídeo convertido para tocar no navegador)' : ''));
            } else {
                item.error(res.body.error || `Falha ao separar (${res.status})`);
            }
        } catch (e) {
            item.error(e.message);
        }
    }

    async function splitFiles(files) {
        for (const file of files) await splitFile(file);
        await refreshAll();
    }

    // File picker + drag-and-drop wiring shared by both upload areas
    function bindUploadArea(zone, input, handler) {
        input.addEventListener('change', () => {
            const files = [...input.files];
            input.value = '';
            if (files.length) handler(files);
        });
        ['dragenter', 'dragover'].forEach(evt => zone.addEventListener(evt, e => {
            e.preventDefault();
            zone.classList.add('dragover');
        }));
        ['dragleave', 'drop'].forEach(evt => zone.addEventListener(evt, e => {
            e.preventDefault();
            zone.classList.remove('dragover');
        }));
        zone.addEventListener('drop', e => {
            const files = [...e.dataTransfer.files];
            if (files.length) handler(files);
        });
    }

    bindUploadArea(dropZone, mediaInput, uploadFiles);
    bindUploadArea(document.getElementById('splitDropZone'), document.getElementById('splitInput'), splitFiles);

    addTotemBtn.addEventListener('click', () => openTotemEditor());

    // ── Embed code modal ───────────────────────────────
    const embedModal = document.getElementById('embedModal');
    const embedFields = {
        width: document.getElementById('embedWidth'),
        height: document.getElementById('embedHeight'),
        fit: document.getElementById('embedFit'),
        listen: document.getElementById('embedListen'),
        responsive: document.getElementById('embedResponsive'),
        showQr: document.getElementById('embedShowQr'),
        qrSeparate: document.getElementById('embedQrSeparate'),
        qrLink: document.getElementById('embedQrLink'),
        pair: document.getElementById('embedPair'),
    };
    const embedCode = document.getElementById('embedCode');
    const embedQrCode = document.getElementById('embedQrCode');
    const embedPreview = document.getElementById('embedPreview');
    let embedCampaign = null;

    function embedOptions() {
        return {
            origin: location.origin,
            campaign: embedCampaign,
            width: embedFields.width.value,
            height: embedFields.height.value,
            fit: embedFields.fit.value,
            listen: embedFields.listen.value,
            responsive: embedFields.responsive.checked,
            showQr: embedFields.showQr.checked,
            qrSeparate: embedFields.qrSeparate.checked,
            qrLink: embedFields.qrLink.checked,
            pair: embedFields.pair.value.trim().replace(/[^A-Za-z0-9_-]/g, ''),
        };
    }

    function refreshEmbedCode() {
        if (!embedCampaign) return;
        const opts = embedOptions();
        document.getElementById('embedPairGroup').hidden = !opts.qrSeparate;
        embedFields.showQr.disabled = opts.qrSeparate; // the totem never shows its own QR then
        // Separate QR: video and QR snippets in their own boxes
        const parts = EmbedCode.buildEmbedParts(opts);
        embedCode.value = parts.video;
        embedQrCode.value = parts.qr || '';
        document.getElementById('embedQrCodeGroup').hidden = !parts.qr;
        document.getElementById('embedCodeLabel').textContent =
            parts.qr ? 'Código do vídeo' : 'Código para colar no site';
        // Separate QR: preview page with both iframes side by side
        embedPreview.href = opts.qrSeparate
            ? `/static/embed-preview.html?${new URLSearchParams({ screen: opts.campaign, pair: opts.pair, fit: opts.fit, listen: opts.listen, qrlink: opts.qrLink ? '' : 'false' })}`
            : EmbedCode.buildEmbedUrl(opts);
    }

    function openEmbedEditor(campaign) {
        embedCampaign = campaign;
        document.getElementById('embedTitle').textContent = `Incorporar em um site — ${campaign}`;
        refreshEmbedCode();
        embedModal.classList.remove('fade-out');
    }

    function closeEmbedEditor() {
        embedModal.classList.add('fade-out');
        embedCampaign = null;
    }

    Object.values(embedFields).forEach(el => el.addEventListener('input', refreshEmbedCode));
    embedModal.querySelectorAll('[data-close-embed]').forEach(btn => btn.addEventListener('click', closeEmbedEditor));
    embedModal.addEventListener('click', (e) => { if (e.target === embedModal) closeEmbedEditor(); });

    // One "Copiar" per box (data-copy = textarea id)
    embedModal.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
        const box = document.getElementById(btn.dataset.copy);
        try {
            await navigator.clipboard.writeText(box.value);
        } catch (_) {
            // Clipboard API needs https/localhost; fall back to selecting the text
            box.select();
            document.execCommand('copy');
        }
        btn.innerHTML = '<i data-lucide="check"></i> Copiado';
        lucide.createIcons();
        setTimeout(() => {
            btn.innerHTML = '<i data-lucide="copy"></i> Copiar';
            lucide.createIcons();
        }, 1500);
    }));

    // ── Mobile page links editor ───────────────────────
    const promoModal = document.getElementById('promoModal');
    const promoForm = document.getElementById('promoForm');
    const promoTitle = document.getElementById('promoTitle');
    const promoLinks = document.getElementById('promoLinks');
    const promoError = document.getElementById('promoError');
    const promoSaveBtn = document.getElementById('promoSaveBtn');
    const addLinkBtn = document.getElementById('addLinkBtn');
    const promoFields = {
        text: document.getElementById('promoText'),
        appLabel: document.getElementById('promoAppLabel'),
        ios: document.getElementById('promoAppIos'),
        android: document.getElementById('promoAppAndroid'),
        fallback: document.getElementById('promoAppFallback'),
    };

    let promoOptions = null;   // { icons, max_links, defaults } from the server

    // Display names for the Lucide icons the server allows
    const ICON_LABELS = {
        'link': 'Link', 'globe': 'Site', 'utensils': 'Comida', 'shopping-bag': 'Loja',
        'camera': 'Instagram', 'at-sign': 'X / @', 'message-circle': 'Mensagem',
        'play': 'Vídeo', 'music': 'Música', 'ticket': 'Ingresso', 'gift': 'Presente',
        'map-pin': 'Localização', 'phone': 'Telefone', 'mail': 'E-mail', 'star': 'Estrela',
        'heart': 'Coração',
    };
    let promoTotemId = null;

    async function loadPromoOptions() {
        if (promoOptions) return promoOptions;
        const res = await api('/api/promo/options');
        if (!res.ok) {
            // 404 here usually means the server process predates this feature
            throw new Error(res.status === 404
                ? 'O servidor está rodando uma versão antiga. Reinicie (npm start) e recarregue esta página.'
                : `Erro no servidor (${res.status}).`);
        }
        promoOptions = await res.json();
        return promoOptions;
    }

    function showPromoError(msg) {
        promoError.textContent = msg;
        promoError.hidden = !msg;
    }

    function updateLinkControls() {
        const rows = promoLinks.querySelectorAll('.link-row');
        addLinkBtn.disabled = rows.length >= promoOptions.max_links;
        let empty = promoLinks.querySelector('.empty');
        if (!rows.length && !empty) {
            empty = document.createElement('p');
            empty.className = 'empty';
            empty.textContent = 'Nenhum link. Adicione um abaixo.';
            promoLinks.appendChild(empty);
        } else if (rows.length && empty) {
            empty.remove();
        }
    }

    function addLinkRow(link = { label: '', url: '', icon: 'link' }) {
        const row = document.createElement('div');
        row.className = 'link-row';

        const label = document.createElement('input');
        label.className = 'text-input link-label';
        label.placeholder = 'Texto';
        label.maxLength = 30;
        label.value = link.label;
        label.setAttribute('aria-label', 'Texto do link');

        const url = document.createElement('input');
        url.className = 'text-input link-url';
        url.type = 'url';
        url.placeholder = 'https://...';
        url.value = link.url;
        url.setAttribute('aria-label', 'Endereço do link');

        const icon = document.createElement('select');
        icon.className = 'custom-select link-icon';
        icon.setAttribute('aria-label', 'Ícone do link');
        promoOptions.icons.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = ICON_LABELS[name] || name;
            opt.selected = name === link.icon;
            icon.appendChild(opt);
        });

        const remove = iconButton('trash-2', 'Remover link', 'danger');
        remove.addEventListener('click', () => {
            row.remove();
            updateLinkControls();
        });

        row.append(label, url, icon, remove);
        promoLinks.appendChild(row);
        lucide.createIcons();
        updateLinkControls();
        return row;
    }

    function fillPromoForm(promo) {
        const app = promo.app || {};
        promoFields.text.value = promo.text || '';
        promoFields.appLabel.value = app.label || '';
        promoFields.ios.value = app.ios || '';
        promoFields.android.value = app.android || '';
        promoFields.fallback.value = app.fallback || '';
        promoLinks.innerHTML = '';
        (promo.links || []).forEach(l => addLinkRow(l));
        updateLinkControls();
    }

    function readPromoForm() {
        return {
            text: promoFields.text.value,
            app: {
                label: promoFields.appLabel.value,
                ios: promoFields.ios.value,
                android: promoFields.android.value,
                fallback: promoFields.fallback.value,
            },
            links: [...promoLinks.querySelectorAll('.link-row')].map(row => ({
                label: row.querySelector('.link-label').value,
                url: row.querySelector('.link-url').value,
                icon: row.querySelector('.link-icon').value,
            })),
        };
    }

    async function openPromoEditor(totemId) {
        try {
            await loadPromoOptions();
        } catch (e) {
            return alert(`Não foi possível abrir o editor de links. ${e.message}`);
        }
        promoTotemId = totemId;
        promoTitle.textContent = `Links da página do celular — ${totemId}`;
        showPromoError('');
        const totem = totemsById[totemId];
        fillPromoForm((totem && totem.promo) || promoOptions.defaults);
        promoModal.classList.remove('fade-out');
        promoFields.text.focus();
    }

    function closePromoEditor() {
        promoModal.classList.add('fade-out');
        promoTotemId = null;
    }

    addLinkBtn.addEventListener('click', () => addLinkRow().querySelector('.link-label').focus());

    document.getElementById('promoResetBtn').addEventListener('click', () => {
        if (confirm('Trocar o formulário pelo texto e links padrão?')) {
            fillPromoForm(promoOptions.defaults);
            showPromoError('');
        }
    });

    promoModal.querySelectorAll('[data-close-promo]').forEach(btn =>
        btn.addEventListener('click', closePromoEditor));
    promoModal.addEventListener('click', (e) => {
        if (e.target === promoModal) closePromoEditor();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!promoModal.classList.contains('fade-out')) closePromoEditor();
        if (!totemModal.classList.contains('fade-out')) closeTotemEditor();
        if (!embedModal.classList.contains('fade-out')) closeEmbedEditor();
        if (!qrModal.classList.contains('fade-out')) qrModal.classList.add('fade-out');
    });

    promoForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!promoTotemId) return;
        showPromoError('');
        promoSaveBtn.disabled = true;
        try {
            const res = await api(`/api/totem/${encodeURIComponent(promoTotemId)}/promo`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(readPromoForm()),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                showPromoError(body.error || `Não foi possível salvar (${res.status})`);
                return;
            }
            closePromoEditor();
            await fetchTotems();
        } catch (err) {
            showPromoError('Não foi possível falar com o servidor.');
        } finally {
            promoSaveBtn.disabled = false;
        }
    });

    closeModalBtn.addEventListener('click', () => {
        qrModal.classList.add('fade-out');
    });

    qrModal.addEventListener('click', (e) => {
        if(e.target === qrModal) qrModal.classList.add('fade-out');
    });

    // ── Statistics (per day, all servers) ──
    const STAT_METRICS = {
        screens: { label: 'Telas abertas', value: c => c.screens },
        scans: { label: 'Escaneamentos', value: c => c.scans },
        listeners: { label: 'Celulares ouvindo', value: c => c.listeners },
        avg: { label: 'Tempo médio ouvindo', value: c => (c.listens ? c.listen_seconds / c.listens : 0), time: true },
    };
    const statsCampaign = document.getElementById('statsCampaign');
    const statsDays = document.getElementById('statsDays');
    const statsCsv = document.getElementById('statsCsv');
    const statsError = document.getElementById('statsError');
    let statsData = null;
    let statsMetric = 'screens';

    const emptyCounters = () => ({ screens: 0, scans: 0, listeners: 0, listen_seconds: 0, listens: 0, sites: {} });

    function addCounters(total, c) {
        for (const k of ['screens', 'scans', 'listeners', 'listen_seconds', 'listens']) total[k] += c[k] || 0;
        for (const [site, n] of Object.entries(c.sites || {})) total.sites[site] = (total.sites[site] || 0) + n;
        return total;
    }

    // One campaign, or all of them added up
    function dayCounters(day, campaign) {
        const entries = Object.entries(day.campaigns).filter(([id]) => !campaign || id === campaign);
        return entries.reduce((total, [, c]) => addCounters(total, c), emptyCounters());
    }

    function formatDuration(seconds) {
        const s = Math.round(seconds);
        if (s < 60) return `${s}s`;
        return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    }

    const formatStat = (metric, v) => (STAT_METRICS[metric].time ? formatDuration(v) : v.toLocaleString('pt-BR'));
    const shortDate = date => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

    async function loadStats() {
        const days = statsDays.value;
        try {
            const res = await api(`/api/stats?days=${days}`);
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
            statsData = body;
            statsError.hidden = true;
        } catch (e) {
            statsError.textContent = `Não foi possível carregar as estatísticas: ${e.message}`;
            statsError.hidden = false;
            return;
        }
        // Campaign list: current campaigns plus any that only exist in old days
        const ids = new Set(statsData.days.flatMap(d => Object.keys(d.campaigns)));
        document.querySelectorAll('.totem-card .totem-id').forEach(el => ids.add(el.textContent));
        const selected = statsCampaign.value;
        statsCampaign.innerHTML = '<option value="">Todas as campanhas</option>' +
            [...ids].sort().map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
        statsCampaign.value = ids.has(selected) ? selected : '';
        renderStats();
    }

    function renderStats() {
        if (!statsData) return;
        const campaign = statsCampaign.value;
        const perDay = statsData.days.map(d => ({ date: d.date, c: dayCounters(d, campaign) }));
        const total = perDay.reduce((t, d) => addCounters(t, d.c), emptyCounters());

        statsCsv.href = `/api/stats.csv?days=${statsDays.value}${campaign ? `&campaign=${encodeURIComponent(campaign)}` : ''}`;

        document.querySelectorAll('.stat-card').forEach(card => {
            const metric = card.dataset.metric;
            card.querySelector('.stat-value').textContent = formatStat(metric, STAT_METRICS[metric].value(total));
            card.classList.toggle('active', metric === statsMetric);
            card.setAttribute('aria-pressed', metric === statsMetric);
        });

        // Daily bars of the selected metric
        const values = perDay.map(d => STAT_METRICS[statsMetric].value(d.c));
        const max = Math.max(...values, 1);
        const chart = document.getElementById('statsChart');
        // A date label every ~48px, whatever the screen width
        const labelEvery = Math.ceil(perDay.length / Math.max(Math.floor(chart.clientWidth / 48), 2));
        chart.setAttribute('aria-label', `${STAT_METRICS[statsMetric].label} por dia`);
        chart.innerHTML = perDay.map((d, i) => {
            const v = values[i];
            const tip = `${shortDate(d.date)}: ${formatStat(statsMetric, v)}`;
            return `<div class="bar-col" title="${escapeHtml(tip)}">
                <div class="bar" style="height:${Math.max((v / max) * 100, v ? 2 : 0)}%"></div>
                <span class="bar-label">${(perDay.length - 1 - i) % labelEvery === 0 ? shortDate(d.date) : ''}</span>
            </div>`;
        }).join('');

        const sites = Object.entries(total.sites).sort((a, b) => b[1] - a[1]);
        const sitesPage = pageOf('sites', sites, 10);
        renderPager('sites', sitesPage, renderStats);
        document.getElementById('statsSites').innerHTML = sites.length
            ? sitesPage.items.map(([site, n]) => `<tr><td>${escapeHtml(site)}</td><td>${n.toLocaleString('pt-BR')}</td></tr>`).join('')
            : '<tr><td colspan="2" class="empty">Nenhuma tela aberta no período.</td></tr>';
    }

    document.querySelectorAll('.stat-card').forEach(card => card.addEventListener('click', () => {
        statsMetric = card.dataset.metric;
        renderStats();
    }));
    statsCampaign.addEventListener('change', renderStats);
    statsDays.addEventListener('change', loadStats);

    // ── Users and activity log (Admin role only) ──
    const usersList = document.getElementById('usersList');
    const userError = document.getElementById('userError');
    const ROLE_LABELS = { admin: 'Admin', editor: 'Editor' };

    function showUserError(msg) {
        userError.textContent = msg;
        userError.hidden = !msg;
    }

    async function usersApi(method, url, body) {
        const res = await api(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
        return data;
    }

    let lastUsers = [];
    async function loadUsers() {
        try {
            lastUsers = await usersApi('GET', '/api/users');
            renderUsers();
        } catch (e) {
            showUserError(`Não foi possível carregar os usuários: ${e.message}`);
        }
    }

    function renderUsers() {
        const page = pageOf('users', lastUsers, 10);
        renderPager('users', page, renderUsers);
        usersList.innerHTML = page.items.map(u => `
            <tr data-name="${escapeHtml(u.name)}">
                <td>${escapeHtml(u.name)}${u.name === currentUser.user ? ' <span class="field-hint">(você)</span>' : ''}</td>
                <td>${u.main
                    ? '<span class="field-hint">Admin — conta principal (.env)</span>'
                    : `<select class="custom-select user-role" aria-label="Papel de ${escapeHtml(u.name)}">
                           ${Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${l}</option>`).join('')}
                       </select>`}</td>
                <td><div class="row-actions">${u.main ? '' : `
                    <button type="button" class="btn btn-ghost btn-sm user-password"><i data-lucide="key-round"></i> Nova senha</button>
                    <button type="button" class="icon-btn danger user-delete" title="Excluir" aria-label="Excluir ${escapeHtml(u.name)}"><i data-lucide="trash-2"></i></button>`}</div>
                </td>
            </tr>`).join('');
        lucide.createIcons();
    }

    usersList.addEventListener('change', async e => {
        if (!e.target.classList.contains('user-role')) return;
        const name = e.target.closest('tr').dataset.name;
        try {
            await usersApi('PATCH', `/api/users/${encodeURIComponent(name)}`, { role: e.target.value });
            showUserError('');
            loadAudit();
        } catch (err) {
            showUserError(err.message);
            loadUsers();
        }
    });

    usersList.addEventListener('click', async e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const name = btn.closest('tr').dataset.name;
        try {
            if (btn.classList.contains('user-password')) {
                const password = prompt(`Nova senha para "${name}" (mínimo 8 caracteres).\nAs sessões abertas dessa pessoa serão encerradas.`);
                if (!password) return;
                await usersApi('PATCH', `/api/users/${encodeURIComponent(name)}`, { password });
                alert(`Senha de "${name}" trocada.`);
            } else if (btn.classList.contains('user-delete')) {
                if (!confirm(`Excluir o usuário "${name}"? As sessões abertas dessa pessoa serão encerradas.`)) return;
                await usersApi('DELETE', `/api/users/${encodeURIComponent(name)}`);
            } else {
                return;
            }
            showUserError('');
            loadUsers();
            loadAudit();
        } catch (err) {
            showUserError(err.message);
        }
    });

    document.getElementById('userForm').addEventListener('submit', async e => {
        e.preventDefault();
        const name = document.getElementById('newUserName');
        const password = document.getElementById('newUserPassword');
        try {
            await usersApi('POST', '/api/users', {
                name: name.value.trim(), password: password.value, role: document.getElementById('newUserRole').value,
            });
            name.value = '';
            password.value = '';
            showUserError('');
            loadUsers();
            loadAudit();
        } catch (err) {
            showUserError(err.message);
        }
    });

    let lastAudit = [];
    async function loadAudit() {
        if (currentUser.role !== 'admin') return;
        const list = document.getElementById('auditList');
        try {
            lastAudit = (await usersApi('GET', '/api/audit')).entries;
            renderAudit();
        } catch (err) {
            list.innerHTML = `<tr><td colspan="4" class="empty">Não foi possível carregar: ${escapeHtml(err.message)}</td></tr>`;
        }
    }

    function renderAudit() {
        const list = document.getElementById('auditList');
        const page = pageOf('audit', lastAudit, 25);
        renderPager('audit', page, renderAudit);
        list.innerHTML = lastAudit.length
            ? page.items.map(e => `<tr>
                <td>${new Date(e.time).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td>${escapeHtml(e.user)}</td>
                <td>${escapeHtml(e.action)}</td>
                <td>${escapeHtml(e.target || '')}</td>
            </tr>`).join('')
            : '<tr><td colspan="4" class="empty">Nenhuma atividade registrada ainda.</td></tr>';
    }
    document.getElementById('auditRefresh').addEventListener('click', loadAudit);

    init();
});
