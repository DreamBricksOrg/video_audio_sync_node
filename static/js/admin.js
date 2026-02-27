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

    async function init() {
        await fetchVideos();
        await fetchAudios();
        await fetchTotems();
        // Poll for statuses
        setInterval(fetchTotems, 5000);
    }

    async function fetchVideos() {
        try {
            const res = await fetch('/api/videos');
            videosCache = await res.json();
        } catch (e) {
            console.error('Failed to fetch videos', e);
        }
    }

    async function fetchAudios() {
        try {
            const res = await fetch('/api/audios');
            audiosCache = await res.json();
        } catch (e) {
            console.error('Failed to fetch audios', e);
        }
    }

    async function fetchTotems() {
        try {
            const res = await fetch('/api/totems');
            const totems = await res.json();
            renderTotems(totems);
        } catch (e) {
            console.error('Failed to fetch totems', e);
        }
    }

    function renderTotems(totems) {
        totemGrid.innerHTML = '';
        if (totems.length === 0) {
            totemGrid.innerHTML = '<div style="color: #aaa; margin-top:20px; font-weight:500;">No totems registered yet. Click "Add Totem" to begin.</div>';
            return;
        }

        totems.forEach(totem => {
            const card = document.createElement('div');
            card.className = 'totem-card';

            const videoOptions = videosCache.map(v => 
                `<option value="${v}" ${totem.video === v ? 'selected' : ''}>${v}</option>`
            ).join('');

            const audioOptions = audiosCache.map(a => 
                `<option value="${a}" ${totem.audio === a ? 'selected' : ''}>${a}</option>`
            ).join('');

            const statusClass = totem.is_online ? 'online' : 'offline';
            const statusLabel = totem.is_online ? 'Live' : 'Offline';

            card.innerHTML = `
                <div class="card-header">
                    <div class="totem-id">${totem.id}</div>
                    <div class="status-pill ${statusClass}">
                        <div style="width:6px; height:6px; background:currentColor; border-radius:50%;"></div>
                        ${statusLabel}
                    </div>
                </div>
                <div class="card-metrics">
                    <div class="metric">
                        <span class="metric-label">Mobile Syncs</span>
                        <span class="metric-value">${totem.mobile_count}</span>
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px;">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label>Current Video</label>
                        <select class="custom-select" id="select-video-${totem.id}">
                            <option value="">-- Select a video --</option>
                            ${videoOptions}
                        </select>
                    </div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label>Current Audio (Mobile)</label>
                        <select class="custom-select" id="select-audio-${totem.id}">
                            <option value="">-- Select an audio --</option>
                            ${audioOptions}
                        </select>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="btn btn-yellow assign-btn" data-id="${totem.id}">
                        <i data-lucide="save" style="width: 16px; height: 16px;"></i> Assign
                    </button>
                    <button class="btn btn-dark link-btn" data-id="${totem.id}">
                        <i data-lucide="smartphone" style="width: 16px; height: 16px;"></i> Mobile
                    </button>
                </div>
            `;
            totemGrid.appendChild(card);
        });
        
        lucide.createIcons();

        // Attach events
        document.querySelectorAll('.assign-btn').forEach(btn => {
            btn.addEventListener('click', (e) => handleAssignConfig(e.currentTarget.dataset.id));
        });
        document.querySelectorAll('.link-btn').forEach(btn => {
            btn.addEventListener('click', (e) => handleGenerateLink(e.currentTarget.dataset.id));
        });
    }

    async function handleAssignConfig(totemId) {
        const videoSelect = document.getElementById(`select-video-${totemId}`);
        const audioSelect = document.getElementById(`select-audio-${totemId}`);
        const video = videoSelect.value;
        const audio = audioSelect.value;

        if (!video || !audio) return alert("Please select both a video and an audio.");

        try {
            const res = await fetch(`/api/totem/${totemId}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ video, audio })
            });
            if (res.ok) {
                const btn = document.querySelector(`.assign-btn[data-id="${totemId}"]`);
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<i data-lucide="check" style="width: 16px; height: 16px;"></i> Saved';
                lucide.createIcons();
                setTimeout(() => {
                    btn.innerHTML = originalHtml;
                    lucide.createIcons();
                }, 2000);
            }
        } catch (e) {
            console.error('Failed to assign video', e);
            alert("Error saving configuration.");
        }
    }

    function handleGenerateLink(totemId) {
        const url = `${window.location.origin}/static/mobile.html?screen=${encodeURIComponent(totemId)}`;
        modalTitle.innerText = `Mobile Link for ${totemId}`;
        qrUrlText.innerText = url;
        openLinkBtn.href = url;

        qrcodeContainer.innerHTML = '';
        qrCodeInstance = new QRCode(qrcodeContainer, {
            text: url,
            width: 200,
            height: 200,
            colorDark : "#000000",
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.H
        });

        qrModal.classList.remove('fade-out');
    }

    addTotemBtn.addEventListener('click', () => {
        const id = prompt("Enter new Totem ID (e.g., Totem_1):");
        if (id) {
            fetch(`/api/totem/${id}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    video: videosCache[0] || '',
                    audio: audiosCache[0] || ''
                })
            }).then(() => fetchTotems());
        }
    });

    closeModalBtn.addEventListener('click', () => {
        qrModal.classList.add('fade-out');
    });

    qrModal.addEventListener('click', (e) => {
        if(e.target === qrModal) qrModal.classList.add('fade-out');
    });

    init();
});
