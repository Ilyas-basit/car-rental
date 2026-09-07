
    // ==========================================================================
    // LocaDrive — Application logic (client-side only, in-memory state)
    // Data model, reservation state machine, live filtering/search, forms.
    // ==========================================================================

    // ---- Date helpers ----------------------------------------------------
    const TODAY = new Date();
    TODAY.setHours(0, 0, 0, 0);

    function addDays(base, n) {
        const d = new Date(base);
        d.setDate(d.getDate() + n);
        return d;
    }
    function toISO(d) {
        return d.toISOString().slice(0, 10);
    }
    function fmtDate(iso) {
        // Handles both plain 'YYYY-MM-DD' strings and full timestamptz ISO strings from Supabase.
        const d = new Date(iso);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}/${mm}`;
    }
    function fmtDateTime(date) {
        const d = new Date(date);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        const hh = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${dd}/${mm}/${yyyy} • ${hh}:${min}`;
    }
    function daysBetween(isoStart, isoEnd) {
        const a = new Date(isoStart), b = new Date(isoEnd);
        return Math.round((b - a) / 86400000);
    }
    function rangesOverlap(aStart, aEnd, bStart, bEnd) {
        return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
    }
    function fmtMonthYear(iso) {
        if (!iso) return '—';
        const [y, m] = iso.split('-');
        return `${m}/${y}`;
    }

    // ---- Supabase (real backend — Clients module) ----------------------------
    // Same project as loginstuff.html. Vehicles/Reservations/Contracts below
    // stay in-memory mock data for now; only Clients is wired to Supabase.
    const SUPABASE_URL = 'https://tgfwlfojgjftmrxkeaiu.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRnZndsZm9qZ2pmdG1yeGtlYWl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNjg2NDQsImV4cCI6MjEwMjk0NDY0NH0.wgSvm_gEPwXHy0EmXdAnH3qMru0u_8ZvJH2qWbZDktw';
    let sb = null;

    async function initSupabase() {
        if (window.supabase && window.supabase.createClient) {
            sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            return;
        }
        const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
        sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }

    // ---- Auth gate --------------------------------------------------------
    // Everything (Clients CRUD included) is blocked behind #authGate until
    // sb.auth has a live session. Every sb.from(...) call above therefore
    // only ever runs with an authenticated JWT attached, so RLS's
    // "staff_full_access" (for authenticated) actually applies.
    let dataBooted = false; // guards against loading data twice on repeated auth events
    let currentStaffUserId = null; // auth.users id of the logged-in staff member, used as created_by/recorded_by

    async function handleLogin() {
        const email = document.getElementById('authEmail').value.trim();
        const password = document.getElementById('authPassword').value;
        const errorEl = document.getElementById('authError');
        errorEl.classList.add('hidden');

        if (!email || !password) {
            errorEl.textContent = 'Saisissez votre email et votre mot de passe.';
            errorEl.classList.remove('hidden');
            return;
        }

        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) {
            errorEl.textContent = error.message;
            errorEl.classList.remove('hidden');
        }
        // success is handled by onAuthStateChange below
    }

    async function handleLogout() {
        await sb.auth.signOut();
        dataBooted = false;
    }

    async function showStaffPill(session) {
        const pill = document.getElementById('staffPill');
        const nameEl = document.getElementById('staffPillName');
        const greetingEl = document.getElementById('dashboardGreeting');
        let displayName = session.user.email || 'Admin';
        pill.classList.remove('hidden');
        pill.classList.add('flex');
        nameEl.textContent = displayName; // placeholder until staff row loads
        if (greetingEl) greetingEl.textContent = `Bonjour, ${displayName}`;
        const { data, error } = await sb.from('staff').select('full_name').eq('id', session.user.id).single();
        if (!error && data && data.full_name) {
            displayName = data.full_name;
            nameEl.textContent = displayName;
            if (greetingEl) greetingEl.textContent = `Bonjour, ${displayName}`;
        }
    }

    function hideStaffPill() {
        const pill = document.getElementById('staffPill');
        pill.classList.add('hidden');
        pill.classList.remove('flex');
    }

    async function onAuthenticated(session) {
        currentStaffUserId = session.user.id;
        document.getElementById('authGate').style.display = 'none';
        showStaffPill(session);
        if (!dataBooted) {
            dataBooted = true;
            // Best-effort real OVERDUE detection (same job pg_cron runs hourly).
            // Non-blocking: detectOverdue() below still catches it client-side either way.
            try { await sb.rpc('mark_overdue_reservations'); } catch (e) { console.warn('mark_overdue_reservations rpc unavailable:', e); }

            await Promise.all([loadClients(), loadVehicles()]);
            await loadReservations(); // reservations reference clients + vehicles by id
            await loadContracts();    // contracts reference reservations by id
            renderAll();
        }
    }

    function onUnauthenticated() {
        document.getElementById('authGate').style.display = 'flex';
        hideStaffPill();
        document.getElementById('authPassword').value = '';
    }

    // Maps a `clients` table row (see database.mysql) to the shape the rest of
    // this app already expects (name/phone/permis/tags/blacklisted/note), while
    // keeping the raw fields around for the edit form.
    function mapClientRow(row) {
        const tags = [];
        if (row.is_vip) tags.push('VIP');
        if (row.risk_level === 'MEDIUM' && !row.is_blacklisted) tags.push('Signalé');
        return {
            id: row.id,
            name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Sans nom',
            phone: row.phone || '—',
            email: row.email || '',
            permis: row.license_expiry ? fmtMonthYear(row.license_expiry) : (row.license_number ? row.license_number : '—'),
            tags,
            blacklisted: !!row.is_blacklisted,
            note: row.notes || 'Aucune note',
            address: row.address || '',
            // raw fields, used to prefill the edit form
            first_name: row.first_name || '',
            last_name: row.last_name || '',
            license_number: row.license_number || '',
            license_expiry: row.license_expiry || '',
            cin_number: row.cin_number || '',
            risk_level: row.risk_level || 'LOW',
            is_vip: !!row.is_vip,
            is_blacklisted: !!row.is_blacklisted,
            notes: row.notes || '',
        };
    }

    let clientsLoaded = false;

    async function loadClients() {
        const { data, error } = await sb.from('clients').select('*').order('created_at', { ascending: false });
        clientsLoaded = true;
        if (error) {
            console.error('Erreur chargement clients:', error);
            const tbody = document.getElementById('clients-tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="px-lg py-lg text-center text-error">Erreur de chargement des clients : ${error.message}</td></tr>`;
            return;
        }
        DB.clients = data.map(mapClientRow);
        renderClients();
    }

    // ---- OCR documents -------------------------------------------------------
    // Supervisor reference: https://github.com/nahlibee/OCR-rex
    // OCR-rex runs as a local PaddleOCR service. Manual entry remains available
    // when the service is offline or cannot confidently read a document.
    const OCR_REX_API = 'http://127.0.0.1:5000';
    function setOcrStatus(message, progress) {
        const box = document.getElementById('ocrStatusBox');
        const text = document.getElementById('ocrStatusText');
        const pct = document.getElementById('ocrProgressText');
        const bar = document.getElementById('ocrProgressBar');
        if (!box || !text || !pct || !bar) return;
        const safeProgress = Math.max(0, Math.min(100, Math.round(progress || 0)));
        box.classList.remove('hidden');
        text.textContent = message;
        pct.textContent = safeProgress + '%';
        bar.style.width = safeProgress + '%';
    }

    function normalizeOcrDate(value) {
        if (!value) return '';
        const cleaned = value.replace(/[^\d./-]/g, '').trim();
        const match = cleaned.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
        if (!match) return '';
        let [, dd, mm, yyyy] = match;
        if (yyyy.length === 2) yyyy = '20' + yyyy;
        return `${yyyy.padStart(4, '0')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }

    function pickOcrValue(text, labels) {
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        for (const label of labels) {
            const direct = new RegExp(`${label}\\s*[:\\-]?\\s*([A-ZÀ-ÿ0-9][A-ZÀ-ÿ0-9 '\\/-]{1,60})`, 'i');
            const found = text.match(direct);
            if (found) return found[1].trim();
            const index = lines.findIndex(line => new RegExp(label, 'i').test(line));
            if (index >= 0 && lines[index + 1]) return lines[index + 1].trim();
        }
        return '';
    }

    function cleanOcrPersonName(value) {
        return (value || '')
            .replace(/[^A-ZÀ-ÿ '\-]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractCniNameCandidates(rawText) {
        const ignored = /^(CARTE|NATIONALE|IDENTITE|IDENTITÉ|ROYAUME|MAROC|NOM|PRENOM|PRÉNOM|NE\s*LE|NÉ\s*LE|NELE|SEXE|VALIDITE|VALIDITÉ)$/i;
        const lines = rawText
            .split(/\r?\n/)
            .map(original => ({
                original: original.trim(),
                cleaned: cleanOcrPersonName(original)
                    .replace(/^(?:N[EÉ]\s*LE|NELE|NOM|PRENOM|PRÉNOM)\s*[:.\-]?\s*/i, '')
                    .trim(),
            }))
            .filter(item => item.cleaned)
            .filter(item => !/[%{}=|<>]/.test(item.original))
            .map(item => item.cleaned)
            .filter(line => !ignored.test(line))
            .filter(line => !/(CARTE|NATIONALE|IDENTIT|ROYAUME|MAROC)/i.test(line))
            .filter(line => line.length >= 2 && line.length <= 35)
            .filter(line => line.split(/\s+/).length <= 2);

        if (lines.length >= 2) return lines.slice(0, 2);

        const tokens = rawText
            .split(/\s+/)
            .map(token => token.trim())
            .filter(token => /^[A-ZÀ-ÖØ-Þ]{2,25}$/.test(token))
            .filter(token => !ignored.test(token))
            .filter(token => !/(CARTE|NATIONALE|IDENTIT|ROYAUME|MAROC)/i.test(token));

        return tokens.slice(0, 2);
    }

    function parseClientDocumentText(rawText) {
        const text = rawText.replace(/[|]/g, 'I').replace(/\s{2,}/g, ' ').trim();
        const compactText = text.replace(/\s+/g, ' ');
        const isMoroccanCni = /(CARTE\s*NATIONALE|NATIONALE\s*D.?IDENTIT|ROYAUME\s*DU\s*MAROC|ROYAUMEDUMAROC)/i.test(compactText);
        const licenseMatch = isMoroccanCni ? null : compactText.match(/\b([A-Z]{1,3}[-\s]?\d{4,}|\d{5,}\/?\d{0,4})\b/);
        const cinMatch = compactText.match(/\b([A-Z]{1,2})\s*[-.]?\s*(\d{5,8})\b/i);
        const expiryText = pickOcrValue(text, [
            'date d.expiration',
            'expiration',
            'date de validite',
            'valable jusqu',
            'expiry',
            'expires'
        ]);
        const fullName = pickOcrValue(text, ['nom complet', 'full name']);
        let lastName = pickOcrValue(text, ['nom', 'surname', 'last name']);
        let firstName = pickOcrValue(text, ['prenom', 'prénom', 'given names', 'first name']);

        if ((!firstName || !lastName) && fullName) {
            const parts = fullName.split(/\s+/);
            lastName = lastName || parts.shift() || '';
            firstName = firstName || parts.join(' ');
        }

        if (isMoroccanCni) {
            const candidates = extractCniNameCandidates(rawText);
            lastName = candidates[0] || lastName || '';
            firstName = candidates[1] || firstName || '';
        }

        return {
            firstName: cleanOcrPersonName(firstName),
            lastName: cleanOcrPersonName(lastName),
            licenseNumber: licenseMatch ? licenseMatch[1].replace(/\s/g, '') : '',
            cinNumber: cinMatch ? `${cinMatch[1]}${cinMatch[2]}`.toUpperCase() : '',
            licenseExpiry: isMoroccanCni ? '' : normalizeOcrDate(expiryText || text),
            rawText,
        };
    }

    function applyClientOcrResult(result) {
        const updates = [
            ['newClientFirstName', result.firstName],
            ['newClientLastName', result.lastName],
            ['newClientLicenseNumber', result.licenseNumber],
            ['newClientLicenseExpiry', result.licenseExpiry],
            ['newClientCin', result.cinNumber],
        ];
        let updatedFields = 0;
        updates.forEach(([id, value]) => {
            if (!value) return;
            const field = document.getElementById(id);
            if (!field) return;
            field.value = value;
            field.classList.add('ring-2', 'ring-primary', 'bg-primary/5');
            setTimeout(() => field.classList.remove('ring-2', 'ring-primary', 'bg-primary/5'), 2200);
            updatedFields += 1;
        });
        const notes = document.getElementById('newClientNotes');
        const ocrNote = 'OCR document: verifier les donnees extraites avant sauvegarde.';
        if (notes && !notes.value.includes('OCR document')) {
            notes.value = notes.value ? `${notes.value}\n${ocrNote}` : ocrNote;
        }
        return updatedFields;
    }

    async function recognizeWithOcrRex(file) {
        const healthController = new AbortController();
        const healthTimeout = setTimeout(() => healthController.abort(), 2500);
        try {
            const health = await fetch(`${OCR_REX_API}/health`, { signal: healthController.signal });
            if (!health.ok) throw new Error('OCR-rex indisponible');
        } finally {
            clearTimeout(healthTimeout);
        }

        setOcrStatus('OCR-rex connecte - analyse PaddleOCR...', 25);
        const formData = new FormData();
        formData.append('file', file, file.name);
        const response = await fetch(`${OCR_REX_API}/ocr`, {
            method: 'POST',
            body: formData,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
            throw new Error(payload.message || `Erreur OCR-rex (${response.status})`);
        }
        setOcrStatus('Extraction OCR-rex terminee', 90);
        return payload.rawText || '';
    }

    function hasUsefulOcrText(rawText) {
        const compact = (rawText || '').replace(/[^A-ZÀ-ÿ0-9]/gi, '');
        const words = (rawText || '').match(/[A-ZÀ-ÿ0-9]{2,}/gi) || [];
        return compact.length >= 12 && words.length >= 3;
    }

    async function handleClientOcrFile(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const resultBox = document.getElementById('ocrResultBox');
        const extractedText = document.getElementById('ocrExtractedText');
        if (resultBox) resultBox.classList.add('hidden');
        try {
            setOcrStatus('Preparation du document...', 5);
            const rawText = await recognizeWithOcrRex(file);
            if (!hasUsefulOcrText(rawText)) {
                throw new Error("OCR-rex n'a pas trouve assez de texte fiable sur cette image.");
            }
            const parsed = parseClientDocumentText(rawText);
            const updatedFields = applyClientOcrResult(parsed);
            if (!updatedFields) {
                throw new Error("Le texte a ete lu, mais aucun nom ou numero exploitable n'a ete identifie.");
            }
            if (extractedText) extractedText.textContent = rawText.trim() || 'Aucun texte lisible detecte.';
            if (resultBox) resultBox.classList.remove('hidden');
            setOcrStatus(`OCR-rex termine - ${updatedFields} champ${updatedFields > 1 ? 's' : ''} rempli${updatedFields > 1 ? 's' : ''}`, 100);
        } catch (error) {
            console.error('OCR error:', error);
            setOcrStatus('OCR-rex indisponible ou lecture non fiable', 0);
            const offline = error && (error.name === 'AbortError' || /fetch|indisponible/i.test(error.message || ''));
            showClientModalError(offline
                ? "OCR-rex n'est pas demarre. Lancez ocr-rex-service/start.bat, gardez la fenetre ouverte, puis reessayez."
                : `Lecture refusee : ${error.message || 'document illisible'}. Essayez une photo nette, bien cadree et sans reflet.`
            );
        } finally {
            event.target.value = '';
        }
    }

    // ---- Live data (all loaded from Supabase — see loadClients/loadVehicles/loadReservations/loadContracts) ----
    const DB = {
        clients: [],
        vehicles: [],
        reservations: [],
        activity: [], // stays session-local; real audit trail lives in reservation_audit_log / contract_events
        contracts: [],
    };

    let selectedContractId = null;
    let signatureModalContext = null;
    const signatureDrawingState = {
        client: { drawing: false, hasInk: false },
        agency: { drawing: false, hasInk: false },
    };

    function signatureStorageKey(contractPk, party) {
        return `locadrive:signature:${contractPk}:${party}`;
    }

    function getStoredSignature(contractPk, party) {
        try {
            return localStorage.getItem(signatureStorageKey(contractPk, party)) || '';
        } catch (_error) {
            return '';
        }
    }

    function contractHasCapturedSignatures(contract) {
        return Boolean(contract && getStoredSignature(contract._pk, 'client') && getStoredSignature(contract._pk, 'agency'));
    }

    function signatureCanvas(party) {
        return document.getElementById(`${party}SignatureCanvas`);
    }

    function signaturePoint(canvas, event) {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function bindSignatureCanvas(party) {
        const canvas = signatureCanvas(party);
        if (!canvas || canvas.dataset.signatureBound === 'true') return;
        canvas.dataset.signatureBound = 'true';
        const state = signatureDrawingState[party];
        canvas.addEventListener('pointerdown', event => {
            event.preventDefault();
            state.drawing = true;
            state.hasInk = true;
            canvas.setPointerCapture(event.pointerId);
            const point = signaturePoint(canvas, event);
            const ctx = canvas.getContext('2d');
            ctx.beginPath();
            ctx.moveTo(point.x, point.y);
        });
        canvas.addEventListener('pointermove', event => {
            if (!state.drawing) return;
            event.preventDefault();
            const point = signaturePoint(canvas, event);
            const ctx = canvas.getContext('2d');
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
        });
        const stopDrawing = event => {
            if (!state.drawing) return;
            state.drawing = false;
            try { canvas.releasePointerCapture(event.pointerId); } catch (_error) {}
        };
        canvas.addEventListener('pointerup', stopDrawing);
        canvas.addEventListener('pointercancel', stopDrawing);
        canvas.addEventListener('pointerleave', stopDrawing);
    }

    function prepareSignatureCanvas(party, storedImage) {
        const canvas = signatureCanvas(party);
        if (!canvas) return;
        bindSignatureCanvas(party);
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.strokeStyle = '#15304a';
        ctx.lineWidth = 2.25;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        signatureDrawingState[party].hasInk = false;
        if (storedImage) {
            const image = new Image();
            image.onload = () => {
                ctx.drawImage(image, 0, 0, rect.width, rect.height);
                signatureDrawingState[party].hasInk = true;
            };
            image.src = storedImage;
        }
    }

    function clearSignatureCanvas(party) {
        prepareSignatureCanvas(party, '');
    }

    function showSignatureError(message) {
        const error = document.getElementById('signatureModalError');
        error.textContent = message;
        error.classList.remove('hidden');
    }

    function openSignatureModal(contractPk, resumeReservationId) {
        const contract = DB.contracts.find(c => c._pk === contractPk);
        if (!contract) {
            alert('Contrat introuvable. Rechargez la page puis réessayez.');
            return;
        }
        const reservation = DB.reservations.find(r => r.id === contract.reservationId);
        const client = reservation ? getClient(reservation.clientId) : null;
        signatureModalContext = { contractPk, resumeReservationId: resumeReservationId || null };
        document.getElementById('signatureModalTitle').textContent = `Signer le contrat ${contract.id}`;
        document.getElementById('signatureModalClient').textContent = client ? `Client : ${client.name}` : 'Client lié au contrat';
        document.getElementById('signatureAgencyName').value = document.getElementById('staffPillName').textContent.trim();
        document.getElementById('signatureConsent').checked = false;
        document.getElementById('signatureModalError').classList.add('hidden');
        document.getElementById('signatureModal').style.display = 'flex';
        requestAnimationFrame(() => {
            prepareSignatureCanvas('client', getStoredSignature(contractPk, 'client'));
            prepareSignatureCanvas('agency', getStoredSignature(contractPk, 'agency'));
        });
    }

    function closeSignatureModal() {
        document.getElementById('signatureModal').style.display = 'none';
        signatureModalContext = null;
    }

    async function saveContractSignatures() {
        if (!signatureModalContext) return;
        const contract = DB.contracts.find(c => c._pk === signatureModalContext.contractPk);
        const agencyName = document.getElementById('signatureAgencyName').value.trim();
        const consent = document.getElementById('signatureConsent').checked;
        const saveButton = document.getElementById('saveSignaturesBtn');
        document.getElementById('signatureModalError').classList.add('hidden');
        if (!signatureDrawingState.client.hasInk || !signatureDrawingState.agency.hasInk) {
            showSignatureError('Les signatures du client et de l’agence sont obligatoires.');
            return;
        }
        if (!agencyName) {
            showSignatureError('Indiquez le nom du représentant de l’agence.');
            return;
        }
        if (!consent) {
            showSignatureError('La confirmation des deux parties est obligatoire.');
            return;
        }

        const clientImage = signatureCanvas('client').toDataURL('image/png');
        const agencyImage = signatureCanvas('agency').toDataURL('image/png');
        const signedAt = new Date().toISOString();
        const resumeReservationId = signatureModalContext.resumeReservationId;
        saveButton.disabled = true;
        saveButton.textContent = 'Enregistrement...';
        try {
            const nextStatus = ['ACTIVE', 'CLOSED'].includes(contract.status) ? contract.status : 'SIGNED';
            const { error } = await sb.from('contracts').update({
                status: nextStatus,
                client_signed_at: signedAt,
                agency_signed_at: signedAt,
            }).eq('id', contract._pk);
            if (error) throw error;
            const { error: eventError } = await sb.from('contract_events').insert([
                { contract_id: contract._pk, event: 'Signature client capturée', occurred_at: signedAt },
                { contract_id: contract._pk, event: `Signature agence capturée (${agencyName})`, occurred_at: signedAt },
            ]);
            if (eventError) throw eventError;
            localStorage.setItem(signatureStorageKey(contract._pk, 'client'), clientImage);
            localStorage.setItem(signatureStorageKey(contract._pk, 'agency'), agencyImage);
            closeSignatureModal();
            await loadContracts();
            renderAll();
            if (resumeReservationId) await performCheckIn(resumeReservationId);
        } catch (error) {
            console.error('Erreur signature contrat:', error);
            showSignatureError("Impossible d’enregistrer les signatures. Vérifiez la connexion puis réessayez.");
        } finally {
            saveButton.disabled = false;
            saveButton.textContent = 'Enregistrer les signatures';
        }
    }

    // ---- Vehicles (Supabase) ------------------------------------------------
    // Maps a `vehicles` table row to the shape the rest of this app expects
    // (model/plate/category/km/tarif/manualStatus).
    function mapVehicleRow(row) {
        const category = [row.category, row.transmission, row.year].filter(Boolean).join(' · ');
        return {
            id: row.id,
            model: [row.brand, row.model].filter(Boolean).join(' ') || 'Véhicule',
            plate: row.plate_number,
            category: category || '—',
            km: row.mileage_km || 0,
            tarif: Number(row.daily_rate) || 0,
            manualStatus: (row.status === 'MAINTENANCE' || row.status === 'RETIRED') ? row.status : null,
        };
    }

    async function loadVehicles() {
        const { data, error } = await sb.from('vehicles').select('*').order('created_at', { ascending: true });
        if (error) {
            console.error('Erreur chargement véhicules:', error);
            return;
        }
        DB.vehicles = data.map(mapVehicleRow);
        renderVehicles();
    }

    // ---- Reservations (Supabase) ---------------------------------------------
    function mapReservationRow(row) {
        return {
            id: row.id,
            clientId: row.client_id,
            vehicleId: row.vehicle_id,
            start: row.start_date,
            end: row.end_date,
            status: row.status,
            total: Number(row.total_due) || 0,
            totalPaid: Number(row.total_paid) || 0,
        };
    }

    async function loadReservations() {
        const { data, error } = await sb.from('reservations').select('*').order('created_at', { ascending: false });
        if (error) {
            console.error('Erreur chargement réservations:', error);
            return;
        }
        DB.reservations = data.map(mapReservationRow);
        renderReservations();
    }

    // ---- Contracts (Supabase) -------------------------------------------------
    // NOTE: contract.id here is the human-readable contract_number (what the
    // rest of the app already displays/selects by) — the real uuid primary
    // key is kept separately as contract._pk for writes.
    function mapContractRow(row) {
        const events = (row.contract_events || [])
            .slice()
            .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
        return {
            id: row.contract_number,
            _pk: row.id,
            reservationId: row.reservation_id,
            status: row.status,
            templateVersion: row.template_version,
            timeline: events.map(e => ({ label: e.event, at: new Date(e.occurred_at) })),
            clientSignedAt: row.client_signed_at ? new Date(row.client_signed_at) : null,
            agencySignedAt: row.agency_signed_at ? new Date(row.agency_signed_at) : null,
        };
    }

    async function loadContracts() {
        const { data, error } = await sb.from('contracts').select('*, contract_events(*)').order('created_at', { ascending: false });
        if (error) {
            console.error('Erreur chargement contrats:', error);
            return;
        }
        DB.contracts = data.map(mapContractRow).filter(c => c.timeline.length > 0);
        renderContractSelector();
    }

    async function createContractForReservation(resId) {
        const contractNumber = 'CTR-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
        const { data, error } = await sb.from('contracts').insert({
            reservation_id: resId,
            contract_number: contractNumber,
            status: 'SENT',
            template_version: 'v1.0',
            sent_at: new Date().toISOString(),
        }).select().single();
        if (error) { console.error('Erreur création contrat:', error); return null; }

        await sb.from('contract_events').insert([
            { contract_id: data.id, event: 'Brouillon généré' },
            { contract_id: data.id, event: 'PDF généré' },
            { contract_id: data.id, event: 'Envoyé au client' },
        ]);
        return data;
    }

    // ---- Derived state / guards --------------------------------------------
    function getClient(id) {
        return DB.clients.find(c => c.id === id) ||
            { id, name: 'Client inconnu', phone: '—', permis: '—', tags: [], blacklisted: false, note: '', email: '', address: '' };
    }
    function getVehicle(id) { return DB.vehicles.find(v => v.id === id); }

    function clientHasActiveReservation(clientId) {
        return DB.reservations.some(r => r.clientId === clientId && (r.status === 'ACTIVE' || r.status === 'OVERDUE'));
    }

    function vehicleEffectiveStatus(vehicleId) {
        const v = getVehicle(vehicleId);
        if (v.manualStatus === 'MAINTENANCE') return 'MAINTENANCE';
        const rented = DB.reservations.some(r => r.vehicleId === vehicleId && (r.status === 'ACTIVE' || r.status === 'OVERDUE'));
        return rented ? 'RENTED' : 'AVAILABLE';
    }

    function isVehicleAvailableForRange(vehicleId, start, end, excludeResId) {
        const v = getVehicle(vehicleId);
        if (v.manualStatus === 'MAINTENANCE') return false;
        return !DB.reservations.some(r =>
            r.vehicleId === vehicleId &&
            r.id !== excludeResId &&
            ['CONFIRMED', 'ACTIVE', 'OVERDUE'].includes(r.status) &&
            rangesOverlap(r.start, r.end, start, end)
        );
    }

    // Simulated hourly cron: CONFIRMED past start w/o check-in, or ACTIVE past end w/o check-out -> OVERDUE
    function detectOverdue() {
        const now = new Date();
        DB.reservations.forEach(r => {
            if (r.status === 'ACTIVE' && new Date(r.end) < now) r.status = 'OVERDUE';
            if (r.status === 'CONFIRMED' && new Date(r.start) < now) r.status = 'OVERDUE';
        });
    }

    function logActivity(title, subtitle, dotClass) {
        DB.activity.unshift({ title, subtitle, dotClass, time: new Date() });
        DB.activity = DB.activity.slice(0, 8);
    }

    // ---- Contract lifecycle (auto-generated at confirmation, per spec 3.4) ----
    // Real create/read live in loadContracts()/createContractForReservation() above.
    function getContractByReservation(resId) {
        return DB.contracts.find(c => c.reservationId === resId);
    }

    // Local-only helper: pushes into the in-memory timeline so the UI updates
    // instantly, in addition to (not instead of) the real contract_events insert
    // done by the caller. Never call this alone if the change needs to persist.
    function appendContractEventLocal(contract, label, atDate) {
        contract.timeline.push({ label, at: atDate || new Date() });
    }

    // ---- State machine actions (write to Supabase, then reload from source of truth) ----
    async function checkIn(resId) {
        const r = DB.reservations.find(x => x.id === resId);
        if (!r || r.status !== 'CONFIRMED') return;
        const contract = getContractByReservation(resId);
        if (!contract) {
            alert('Le contrat lié doit être généré avant le check-in.');
            return;
        }
        if (!contractHasCapturedSignatures(contract)) {
            openSignatureModal(contract._pk, resId);
            return;
        }
        await performCheckIn(resId);
    }

    async function performCheckIn(resId) {
        const r = DB.reservations.find(x => x.id === resId);
        if (!r || r.status !== 'CONFIRMED') return;
        const nowIso = new Date().toISOString();

        const { error } = await sb.from('reservations')
            .update({ status: 'ACTIVE', checkin_at: nowIso })
            .eq('id', resId);
        if (error) { alert('Erreur check-in : ' + error.message); return; }

        await sb.from('reservation_audit_log').insert({
            reservation_id: resId, from_status: 'CONFIRMED', to_status: 'ACTIVE',
            changed_by: currentStaffUserId,
        });

        const contract = getContractByReservation(resId);
        if (contract) {
            await sb.from('contracts').update({ status: 'ACTIVE' }).eq('id', contract._pk);
            await sb.from('contract_events').insert({ contract_id: contract._pk, event: 'Contrat Actif', occurred_at: nowIso });
        }

        logActivity(`Check-in : ${getVehicle(r.vehicleId).model}`, `Client : ${getClient(r.clientId).name}`, 'bg-secondary');
        await Promise.all([loadReservations(), loadContracts()]);
        renderAll();
    }

    async function checkOut(resId) {
        const r = DB.reservations.find(x => x.id === resId);
        if (!r || (r.status !== 'ACTIVE' && r.status !== 'OVERDUE')) return;
        if (!confirm('Confirmer le paiement complet et clôturer la location ?')) return;
        const nowIso = new Date().toISOString();
        const outstanding = r.total - (r.totalPaid || 0);

        if (outstanding > 0) {
            const { error: payErr } = await sb.from('payments').insert({
                reservation_id: resId, amount: outstanding, method: 'cash', recorded_by: currentStaffUserId,
            });
            if (payErr) { alert('Erreur paiement : ' + payErr.message); return; }
        }

        const { error } = await sb.from('reservations')
            .update({ status: 'COMPLETED', checkout_at: nowIso, total_paid: r.total })
            .eq('id', resId);
        if (error) { alert('Erreur check-out : ' + error.message); return; }

        await sb.from('reservation_audit_log').insert({
            reservation_id: resId, from_status: r.status, to_status: 'COMPLETED',
            changed_by: currentStaffUserId,
        });

        const contract = getContractByReservation(resId);
        if (contract) {
            await sb.from('contracts').update({ status: 'CLOSED' }).eq('id', contract._pk);
            await sb.from('contract_events').insert({ contract_id: contract._pk, event: 'Clôture effectuée', occurred_at: nowIso });
        }

        logActivity(`Check-out : ${getVehicle(r.vehicleId).model}`, `Client : ${getClient(r.clientId).name} — ${r.total}€`, 'bg-primary');
        await Promise.all([loadReservations(), loadContracts()]);
        renderAll();
    }

    async function cancelReservation(resId) {
        const r = DB.reservations.find(x => x.id === resId);
        if (!r || r.status !== 'CONFIRMED') return;
        if (!confirm('Annuler cette réservation ?')) return;

        const { error } = await sb.from('reservations')
            .update({ status: 'CANCELLED', cancelled_by: 'AGENCY', cancelled_reason: 'Annulée manuellement par le staff' })
            .eq('id', resId);
        if (error) { alert('Erreur annulation : ' + error.message); return; }

        await sb.from('reservation_audit_log').insert({
            reservation_id: resId, from_status: 'CONFIRMED', to_status: 'CANCELLED',
            changed_by: currentStaffUserId,
        });

        const contract = getContractByReservation(resId);
        if (contract) {
            await sb.from('contracts').update({ status: 'VOID' }).eq('id', contract._pk);
            await sb.from('contract_events').insert({ contract_id: contract._pk, event: 'Contrat annulé' });
        }

        logActivity('Réservation annulée', `${getVehicle(r.vehicleId).model} — ${getClient(r.clientId).name}`, 'bg-error');
        await Promise.all([loadReservations(), loadContracts()]);
        renderAll();
    }

    function contactClient(resId) {
        const r = DB.reservations.find(x => x.id === resId);
        if (!r) return;
        alert(`Client ${getClient(r.clientId).name} contacté au sujet du retard.`);
        logActivity('Client contacté', `${getClient(r.clientId).name} — retour en retard`, 'bg-tertiary');
    }

    function generateInvoice(resId) {
        const r = DB.reservations.find(x => x.id === resId);
        if (!r) return;
        alert(`Facture générée pour la réservation #${r.id} — ${r.total}€`);
    }

    // ---- Rendering: Dashboard ------------------------------------------------
    function renderDashboard() {
        const activeCount = DB.reservations.filter(r => r.status === 'ACTIVE').length;
        const overdueCount = DB.reservations.filter(r => r.status === 'OVERDUE').length;
        const availableCount = DB.vehicles.filter(v => vehicleEffectiveStatus(v.id) === 'AVAILABLE').length;
        const maintenanceCount = DB.vehicles.filter(v => vehicleEffectiveStatus(v.id) === 'MAINTENANCE').length;
        const invoiceableCount = DB.reservations.filter(r => r.status === 'COMPLETED').length;
        const now = new Date();
        const revenueThisMonth = DB.reservations
            .filter(r => r.status === 'COMPLETED' && new Date(r.end).getMonth() === now.getMonth() && new Date(r.end).getFullYear() === now.getFullYear())
            .reduce((s, r) => s + r.total, 0);
        const formatDateInput = (date) => date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const dashboardDateRangeEl = document.getElementById('dashboardDateRange');
        if (dashboardDateRangeEl) dashboardDateRangeEl.value = `${formatDateInput(now)} - ${formatDateInput(now)}`;

        document.getElementById('kpi-locations-actives').textContent = activeCount + overdueCount;
        document.getElementById('kpi-vehicules-dispo').textContent = availableCount;
        document.getElementById('kpi-retards').textContent = overdueCount;
        document.getElementById('kpi-revenu-mois').textContent = revenueThisMonth + '€';
        const maintenanceEl = document.getElementById('kpi-maintenance');
        const invoiceableEl = document.getElementById('kpi-contrats-facturer');
        if (maintenanceEl) maintenanceEl.textContent = maintenanceCount;
        if (invoiceableEl) invoiceableEl.textContent = invoiceableCount;

        renderGantt('dashboard-gantt-header', 'dashboard-gantt-body', 10, 32);
    }

    // ---- Rendering: Clients ---------------------------------------------------
    let clientFilter = 'all';
    function setClientFilter(filter, btn) {
        clientFilter = filter;
        document.querySelectorAll('.client-filter-btn').forEach(b => {
            b.classList.remove('bg-primary', 'text-on-primary', 'font-semibold');
            b.classList.add('bg-surface-container-high', 'text-on-surface-variant', 'font-medium');
        });
        btn.classList.remove('bg-surface-container-high', 'text-on-surface-variant', 'font-medium');
        btn.classList.add('bg-primary', 'text-on-primary', 'font-semibold');
        renderClients();
    }

    function renderClients() {
        const search = (document.getElementById('client-search').value || '').toLowerCase().trim();
        let list = DB.clients.filter(c => {
            if (clientFilter === 'actif' && !clientHasActiveReservation(c.id)) return false;
            if (clientFilter === 'signale' && !c.tags.includes('Signalé')) return false;
            if (clientFilter === 'blackliste' && !c.blacklisted) return false;
            if (clientFilter === 'vip' && !c.tags.includes('VIP')) return false;
            if (search && !(c.name.toLowerCase().includes(search) || c.phone.toLowerCase().includes(search) || c.permis.toLowerCase().includes(search) || (c.email || '').toLowerCase().includes(search))) return false;
            return true;
        });

        document.getElementById('stat-clients-total').textContent = DB.clients.length;
        document.getElementById('stat-clients-actifs').textContent = DB.clients.filter(c => clientHasActiveReservation(c.id)).length;
        document.getElementById('stat-clients-signales').textContent = DB.clients.filter(c => c.tags.includes('Signalé')).length;
        document.getElementById('stat-clients-blacklistes').textContent = DB.clients.filter(c => c.blacklisted).length;
        document.getElementById('clients-pagination-text').textContent = `Affichage de ${list.length} client${list.length !== 1 ? 's' : ''}`;

        const tbody = document.getElementById('clients-tbody');
        tbody.innerHTML = '';
        if (list.length === 0) {
            tbody.innerHTML = clientsLoaded
                ? `<tr><td colspan="6" class="px-lg py-xl text-center">
                    <div class="flex flex-col items-center gap-sm">
                        <div class="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                            <span class="material-symbols-outlined">person_add</span>
                        </div>
                        <p class="font-semibold text-on-surface">Aucun client à afficher</p>
                        <p class="text-body-md text-on-surface-variant">Ajoutez votre premier client ou modifiez le filtre actuel.</p>
                        <button onclick="openAddClientModal()" class="inline-flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 active:scale-95 transition-all">
                            <span class="material-symbols-outlined text-[18px]">add</span>
                            Nouveau client
                        </button>
                    </div>
                </td></tr>`
                : '<tr><td colspan="6" class="px-lg py-lg text-center text-on-surface-variant">Chargement des clients…</td></tr>';
            return;
        }

        const riskMeta = {
            Low:    { cls: 'bg-secondary/10 text-secondary', dot: 'bg-secondary' },
            Medium: { cls: 'bg-tertiary-container/10 text-tertiary', dot: 'bg-tertiary' },
            High:   { cls: 'bg-error-container/30 text-error', dot: 'bg-error animate-pulse' },
        };

        list.forEach(c => {
            const initials = c.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const risk = c.blacklisted ? 'High' : (c.risk_level === 'HIGH' ? 'High' : c.tags.includes('Signalé') ? 'Medium' : 'Low');
            const rm = riskMeta[risk];
            const tagBadges = c.tags.map(t => `<span class="bg-secondary-container text-on-secondary-container text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tighter">${t}</span>`).join(' ');
            const blBadge = c.blacklisted ? `<span class="bg-error text-white text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tighter">Blacklisté</span>` : '';
            const reserveBtn = c.blacklisted ? '' : `<button onclick="openReservationPanel('${c.id}')" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 active:scale-95 transition-all">Réserver</button>`;
            const avatarCls = c.blacklisted ? 'bg-error-container/20 text-error' : (c.tags.includes('VIP') ? 'bg-primary-container/20 text-primary-container' : 'bg-surface-container-highest text-on-surface-variant');

            tbody.insertAdjacentHTML('beforeend', `
                <tr class="hover:bg-surface-container-low/50 transition-colors">
                    <td class="px-lg py-md">
                        <div class="flex items-center gap-md">
                            <div class="w-10 h-10 rounded-full ${avatarCls} flex items-center justify-center font-bold text-body-md">${initials}</div>
                            <div>
                                <div class="flex items-center gap-sm">
                                    <span class="font-semibold text-body-md">${c.name}</span>
                                    ${tagBadges}${blBadge}
                                </div>
                                <span class="text-on-surface-variant text-caption">${c.note}</span>
                            </div>
                        </div>
                    </td>
                    <td class="px-lg py-md text-body-md text-on-surface-variant">${c.phone}</td>
                    <td class="px-lg py-md text-body-md ${c.blacklisted ? 'text-error font-semibold' : 'text-on-surface-variant'}">${c.permis}</td>
                    <td class="px-lg py-md text-body-md text-on-surface-variant">${DB.reservations.filter(r => r.clientId === c.id).length}</td>
                    <td class="px-lg py-md">
                        <span class="inline-flex items-center gap-sm px-sm py-1 rounded-lg ${rm.cls} text-label-md font-bold">
                            <span class="w-2 h-2 rounded-full ${rm.dot}"></span> ${risk}
                        </span>
                    </td>
                    <td class="px-lg py-md text-right">
                        <div class="flex items-center justify-end gap-sm">
                            <button onclick="openClientDetail('${c.id}')" class="px-md py-sm bg-white border border-outline-variant rounded-lg text-body-md font-semibold hover:bg-surface-container-low transition-colors">Voir</button>
                            ${reserveBtn}
                            <button onclick="openEditClientModal('${c.id}')" title="Modifier" class="p-sm bg-white border border-outline-variant rounded-lg hover:bg-surface-container-low transition-colors"><span class="material-symbols-outlined text-[18px] text-on-surface-variant">edit</span></button>
                            <button onclick="deleteClient('${c.id}')" title="Supprimer" class="p-sm bg-white border border-outline-variant rounded-lg hover:bg-error-container/30 transition-colors"><span class="material-symbols-outlined text-[18px] text-error">delete</span></button>
                        </div>
                    </td>
                </tr>`);
        });
    }

    // ---- Rendering: Vehicules ---------------------------------------------------
    let vehiculeFilter = 'all';
    function setVehiculeFilter(filter, btn) {
        vehiculeFilter = filter;
        document.querySelectorAll('.vehicule-filter-btn').forEach(b => {
            b.classList.remove('active-tab', 'font-semibold');
            b.classList.add('text-on-surface-variant');
        });
        btn.classList.add('active-tab', 'font-semibold');
        btn.classList.remove('text-on-surface-variant');
        renderVehicles();
    }

    function renderVehicles() {
        const search = (document.getElementById('vehicule-search') ? document.getElementById('vehicule-search').value : '').toLowerCase().trim();
        let list = DB.vehicles.filter(v => {
            const status = vehicleEffectiveStatus(v.id);
            if (vehiculeFilter === 'available' && status !== 'AVAILABLE') return false;
            if (vehiculeFilter === 'rented' && status !== 'RENTED') return false;
            if (vehiculeFilter === 'maintenance' && status !== 'MAINTENANCE') return false;
            if (search && !(v.model.toLowerCase().includes(search) || v.plate.toLowerCase().includes(search))) return false;
            return true;
        });

        document.getElementById('stat-vehicules-total').textContent = DB.vehicles.length;
        document.getElementById('stat-vehicules-dispo').textContent = DB.vehicles.filter(v => vehicleEffectiveStatus(v.id) === 'AVAILABLE').length;
        const rentedCount = DB.vehicles.filter(v => vehicleEffectiveStatus(v.id) === 'RENTED').length;
        document.getElementById('stat-vehicules-utilisation').textContent = Math.round((rentedCount / DB.vehicles.length) * 100) + '%';
        const avgTarif = Math.round(DB.vehicles.reduce((s, v) => s + v.tarif, 0) / DB.vehicles.length);
        document.getElementById('stat-vehicules-revenu').textContent = avgTarif + '€';

        const grid = document.getElementById('vehicles-grid');
        grid.innerHTML = '';
        if (list.length === 0) {
            grid.innerHTML = '<p class="text-on-surface-variant col-span-full text-center py-lg">Aucun véhicule ne correspond à ce filtre.</p>';
            return;
        }

        const statusMeta = {
            AVAILABLE:   { cls: 'bg-secondary/15 text-secondary', label: 'AVAILABLE' },
            RENTED:      { cls: 'bg-primary/15 text-primary', label: 'RENTED' },
            MAINTENANCE: { cls: 'bg-tertiary-container/20 text-tertiary-container', label: 'MAINTENANCE' },
        };

        list.forEach(v => {
            const status = vehicleEffectiveStatus(v.id);
            const sm = statusMeta[status];
            const maintBtnLabel = v.manualStatus === 'MAINTENANCE' ? 'Sortir de maintenance' : 'Mettre en maintenance';
            grid.insertAdjacentHTML('beforeend', `
                <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden hover:shadow-lg transition-all group flex flex-col min-h-[340px]">
                    <div class="relative h-44 bg-surface-container-high overflow-hidden flex items-center justify-center">
                        <span class="material-symbols-outlined text-7xl text-outline-variant">directions_car</span>
                        <div class="absolute top-4 left-4 px-3 py-1.5 ${sm.cls} text-sm font-bold rounded-full backdrop-blur-sm">${sm.label}</div>
                    </div>
                    <div class="p-lg flex-1 flex flex-col">
                        <div class="flex justify-between items-start gap-md mb-md">
                            <div class="min-w-0">
                                <h4 class="text-xl font-bold text-on-surface leading-tight">${v.model}</h4>
                                <p class="mt-xs text-body-md text-on-surface-variant break-words">${v.plate} • ${v.category}</p>
                            </div>
                            <div class="text-right shrink-0">
                                <p class="text-lg font-bold text-primary">${v.tarif}€/j</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-md mb-lg text-on-surface-variant text-body-md">
                            <div class="flex items-center gap-sm"><span class="material-symbols-outlined text-[20px]">speed</span>${v.km.toLocaleString('fr-FR')} km</div>
                        </div>
                        <button onclick="toggleMaintenance('${v.id}')" class="mt-auto pt-md border-t border-outline-variant/50 text-body-md font-semibold ${v.manualStatus === 'MAINTENANCE' ? 'text-secondary' : 'text-on-surface-variant'} hover:text-primary text-left flex items-center gap-sm"><span class="material-symbols-outlined text-[20px]">build</span>${maintBtnLabel}</button>
                    </div>
                </div>`);
        });
    }

    async function toggleMaintenance(vehicleId) {
        const v = getVehicle(vehicleId);
        const newStatus = v.manualStatus === 'MAINTENANCE' ? 'AVAILABLE' : 'MAINTENANCE';
        const { error } = await sb.from('vehicles').update({ status: newStatus }).eq('id', vehicleId);
        if (error) { alert('Erreur mise à jour véhicule : ' + error.message); return; }
        await loadVehicles();
        renderAll();
    }

    // ---- Rendering: Reservations ---------------------------------------------------
    let resFilter = 'all';
    function setResFilter(filter, btn) {
        resFilter = filter;
        document.querySelectorAll('.res-filter-btn').forEach(b => {
            b.classList.remove('border-primary', 'text-primary', 'font-semibold');
            b.classList.add('border-transparent', 'text-on-surface-variant');
        });
        btn.classList.remove('border-transparent', 'text-on-surface-variant');
        btn.classList.add('border-primary', 'text-primary', 'font-semibold');
        renderReservations();
    }

    const STATUS_META = {
        CONFIRMED: { label: 'CONFIRMÉ', cls: 'bg-primary-container/10 text-primary' },
        ACTIVE:    { label: 'ACTIF',    cls: 'bg-secondary-container/20 text-secondary' },
        OVERDUE:   { label: 'OVERDUE', cls: 'bg-tertiary-container/10 text-tertiary' },
        COMPLETED: { label: 'COMPLÉTÉ', cls: 'bg-surface-container-high text-on-surface-variant' },
        CANCELLED: { label: 'ANNULÉ',  cls: 'bg-error-container/20 text-error' },
    };

    function renderReservations() {
        let list = DB.reservations.filter(r => resFilter === 'all' || r.status === resFilter);
        list = [...list].sort((a, b) => a.start < b.start ? 1 : -1);

        document.getElementById('stat-res-actives').textContent = DB.reservations.filter(r => r.status === 'ACTIVE').length;
        document.getElementById('stat-res-confirmees').textContent = DB.reservations.filter(r => r.status === 'CONFIRMED').length;
        document.getElementById('stat-res-retards').textContent = DB.reservations.filter(r => r.status === 'OVERDUE').length;
        const revenue = DB.reservations.filter(r => r.status !== 'CANCELLED' && r.status !== 'CONFIRMED').reduce((s, r) => s + r.total, 0);
        document.getElementById('stat-res-revenu').textContent = revenue + '€';
        document.getElementById('reservations-pagination-text').textContent = `Affichage de ${list.length} réservation${list.length !== 1 ? 's' : ''}`;

        const tbody = document.getElementById('reservations-tbody');
        tbody.innerHTML = '';
        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="px-md py-lg text-center text-on-surface-variant">Aucune réservation ne correspond à ce filtre.</td></tr>';
            return;
        }

        list.forEach(r => {
            const client = getClient(r.clientId);
            const vehicle = getVehicle(r.vehicleId);
            const sm = STATUS_META[r.status];
            const initials = client.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const nights = daysBetween(r.start, r.end);
            let actions = '';
            if (r.status === 'CONFIRMED') {
                actions = `<button onclick="checkIn('${r.id}')" class="bg-primary text-white px-sm py-1 rounded font-label-md hover:opacity-90 transition-colors">Check-in</button>
                           <button onclick="cancelReservation('${r.id}')" class="border border-outline-variant px-sm py-1 rounded font-label-md hover:bg-error-container hover:text-error hover:border-error transition-all">Annuler</button>`;
            } else if (r.status === 'ACTIVE') {
                actions = `<button onclick="checkOut('${r.id}')" class="bg-secondary text-white px-sm py-1 rounded font-label-md hover:opacity-90 transition-colors">Check-out</button>`;
            } else if (r.status === 'OVERDUE') {
                actions = `<button onclick="checkOut('${r.id}')" class="bg-secondary text-white px-sm py-1 rounded font-label-md hover:opacity-90 transition-colors">Check-out</button>
                           <button onclick="contactClient('${r.id}')" class="border border-outline-variant px-sm py-1 rounded font-label-md hover:bg-surface-container-highest transition-all">Contacter</button>`;
            } else if (r.status === 'COMPLETED') {
                actions = `<button onclick="generateInvoice('${r.id}')" class="border border-outline-variant px-sm py-1 rounded font-label-md hover:bg-surface-container-highest transition-all">Facture</button>`;
            } else {
                actions = `<span class="text-caption text-outline">—</span>`;
            }
            actions += ` <button onclick="viewContractForReservation('${r.id}')" class="border border-outline-variant px-sm py-1 rounded font-label-md hover:bg-surface-container-highest transition-all">Contrat</button>`;

            tbody.insertAdjacentHTML('beforeend', `
                <tr class="hover:bg-surface-container-lowest transition-colors group">
                    <td class="px-md py-md">
                        <div class="flex items-center gap-sm">
                            <div class="w-8 h-8 rounded-full bg-primary-fixed text-on-primary-fixed flex items-center justify-center font-bold text-xs">${initials}</div>
                            <span class="font-body-md font-medium text-on-surface">${client.name}</span>
                        </div>
                    </td>
                    <td class="px-md py-md"><span class="font-body-md text-on-surface-variant">${vehicle.model}</span></td>
                    <td class="px-md py-md">
                        <div class="flex flex-col">
                            <span class="font-body-md">${fmtDate(r.start)} - ${fmtDate(r.end)}</span>
                            <span class="text-xs ${r.status === 'OVERDUE' ? 'text-error font-medium' : 'text-on-surface-variant'}">${nights} jours</span>
                        </div>
                    </td>
                    <td class="px-md py-md"><span class="px-sm py-1 rounded ${sm.cls} font-bold text-[10px] uppercase tracking-wide">${sm.label}</span></td>
                    <td class="px-md py-md font-semibold ${r.status === 'OVERDUE' ? 'text-error' : ''}">${r.total}€</td>
                    <td class="px-md py-md text-right">
                        <div class="flex items-center justify-end gap-sm opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">${actions}</div>
                    </td>
                </tr>`);
        });

        renderGantt('reservations-gantt-header', 'reservations-gantt-body', 20, 40, true);
    }

    // ---- Shared Gantt renderer (10 or 20-day rolling window from today) --------
    function renderGantt(headerId, bodyId, numDays, dayWidth, showPlateSubtitle) {
        const header = document.getElementById(headerId);
        const body = document.getElementById(bodyId);
        if (!header || !body) return;

        header.innerHTML = '';
        for (let i = 0; i < numDays; i++) {
            const d = addDays(TODAY, i);
            const isToday = i === 0;
            header.insertAdjacentHTML('beforeend', `
                <div class="flex-shrink-0 flex items-center justify-center font-caption text-on-surface-variant border-r border-outline-variant ${isToday ? 'bg-surface-container-high font-bold text-primary' : ''}" style="width:${dayWidth}px; height:40px;">
                    ${String(d.getDate()).padStart(2, '0')}
                </div>`);
        }

        body.innerHTML = '';
        const windowStart = TODAY;
        const windowEnd = addDays(TODAY, numDays);
        const colorFor = { CONFIRMED: 'bg-primary-container/70 border-primary text-primary', ACTIVE: 'bg-secondary-container/70 border-secondary text-secondary', OVERDUE: 'bg-tertiary-container/70 border-tertiary text-tertiary' };

        DB.vehicles.forEach(v => {
            const bars = DB.reservations.filter(r =>
                ['CONFIRMED', 'ACTIVE', 'OVERDUE'].includes(r.status) &&
                r.vehicleId === v.id &&
                rangesOverlap(r.start, r.end, toISO(windowStart), toISO(windowEnd))
            );
            let barsHtml = '';
            bars.forEach(r => {
                const client = getClient(r.clientId);
                const startOffset = Math.max(0, daysBetween(toISO(windowStart), r.start));
                const rawEnd = daysBetween(toISO(windowStart), r.end);
                const endOffset = Math.min(numDays, rawEnd);
                const left = startOffset * dayWidth;
                const width = Math.max(dayWidth - 4, (endOffset - startOffset) * dayWidth - 4);
                const colorCls = colorFor[r.status] || colorFor.CONFIRMED;
                barsHtml += `<div class="absolute h-6 top-1/2 -translate-y-1/2 rounded border-l-4 ${colorCls} flex items-center px-sm overflow-hidden whitespace-nowrap shadow-sm cursor-pointer transition-all hover:opacity-90" style="left:${left}px; width:${width}px;" title="${client.name} (${STATUS_META[r.status].label})">
                    <span class="text-[10px] font-bold truncate">${client.name}</span>
                </div>`;
            });
            body.insertAdjacentHTML('beforeend', `
                <div class="flex border-b border-outline-variant last:border-0 hover:bg-surface-container-low transition-colors items-center" style="min-height:48px;">
                    <div class="w-40 flex-shrink-0 border-r border-outline-variant p-sm">
                        <span class="font-body-md">${v.model}</span>
                        ${showPlateSubtitle ? `<p class="text-[10px] text-on-surface-variant">${v.plate}</p>` : ''}
                    </div>
                    <div class="flex-1 relative h-12 overflow-hidden" style="min-width:${numDays * dayWidth}px;">${barsHtml}</div>
                </div>`);
        });
    }

    // ---- Reservation slide-over: client select, vehicle picker, confirm --------
    let selectedVehicleId = null;

    function refreshClientDropdown(preselectClientId) {
        const select = document.getElementById('resClientSelect');
        const bookable = DB.clients.filter(c => !c.blacklisted);
        if (bookable.length === 0) {
            select.innerHTML = '<option value="">Aucun client disponible</option>';
            document.getElementById('resClientPhone').textContent = '—';
            document.getElementById('resClientPermis').textContent = '—';
            const badge = document.getElementById('resClientRiskBadge');
            badge.textContent = 'Risk: —';
            return;
        }
        select.innerHTML = bookable.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        select.value = preselectClientId && !getClient(preselectClientId).blacklisted ? preselectClientId : bookable[0].id;
        onReservationClientChange();
    }

    function onReservationClientChange() {
        const c = getClient(document.getElementById('resClientSelect').value);
        document.getElementById('resClientPhone').textContent = c.phone;
        document.getElementById('resClientPermis').textContent = c.permis;
        const risk = c.tags.includes('Signalé') ? 'Medium' : 'Low';
        const badge = document.getElementById('resClientRiskBadge');
        badge.textContent = `Risk: ${risk}`;
        badge.className = risk === 'Medium'
            ? 'px-sm py-xs bg-tertiary-container/20 text-tertiary text-[10px] font-bold uppercase tracking-wider rounded border border-tertiary-container/30'
            : 'px-sm py-xs bg-secondary/15 text-secondary text-[10px] font-bold uppercase tracking-wider rounded border border-secondary/20';
    }

    function renderVehicleOptionsForPanel() {
        const start = document.getElementById('dateDepart').value;
        const end = document.getElementById('dateRetour').value;
        const list = document.getElementById('resVehicleList');
        list.innerHTML = '';

        const available = DB.vehicles.filter(v => start && end && new Date(end) > new Date(start) && isVehicleAvailableForRange(v.id, start, end, null));

        if (available.length === 0) {
            list.innerHTML = '<p class="text-on-surface-variant text-body-md text-center py-md">Aucun véhicule disponible pour ces dates.</p>';
            selectedVehicleId = null;
            updateCalculations();
            return;
        }
        if (!available.some(v => v.id === selectedVehicleId)) {
            selectedVehicleId = available[0].id;
        }

        available.forEach(v => {
            const selected = v.id === selectedVehicleId;
            list.insertAdjacentHTML('beforeend', `
                <div class="vehicle-card cursor-pointer group p-md bg-white ${selected ? 'border-2 border-primary ring-4 ring-primary/5' : 'border border-outline-variant hover:border-primary/50'} rounded relative flex items-center gap-md transition-all" onclick="selectVehicle('${v.id}')">
                    <div class="w-16 h-14 bg-surface-container rounded overflow-hidden flex-shrink-0 flex items-center justify-center">
                        <span class="material-symbols-outlined text-3xl text-outline-variant">directions_car</span>
                    </div>
                    <div class="flex-1">
                        <p class="font-body-md text-body-md font-bold">${v.model}</p>
                        <p class="font-label-md text-label-md text-on-surface-variant">${v.category}</p>
                        <p class="font-body-md text-body-md ${selected ? 'text-primary' : 'text-on-surface-variant'} font-semibold mt-xs">${v.tarif}€/j</p>
                    </div>
                    ${selected ? '<span class="material-symbols-outlined text-primary">check_circle</span>' : ''}
                </div>`);
        });
        updateCalculations();
    }

    function selectVehicle(vehicleId) {
        selectedVehicleId = vehicleId;
        renderVehicleOptionsForPanel();
    }

    function updateCalculations() {
        const start = document.getElementById('dateDepart').value;
        const end = document.getElementById('dateRetour').value;
        let duration = 0;
        if (start && end && new Date(end) > new Date(start)) duration = daysBetween(start, end);
        const tarif = selectedVehicleId ? getVehicle(selectedVehicleId).tarif : 0;
        document.getElementById('durationDisplay').textContent = `Durée : ${duration} jour${duration !== 1 ? 's' : ''}`;
        document.getElementById('calcBreakdown').textContent = `${tarif}€ x ${duration}j`;
        document.getElementById('totalDisplay').textContent = `${tarif * duration}€`;
    }

    function openReservationPanel(clientId) {
        detectOverdue();
        const start = toISO(addDays(TODAY, 1));
        const end = toISO(addDays(TODAY, 4));
        document.getElementById('dateDepart').value = start;
        document.getElementById('dateRetour').value = end;
        selectedVehicleId = null;
        refreshClientDropdown(clientId);
        renderVehicleOptionsForPanel();

        const backdrop = document.getElementById('slideOverBackdrop');
        const panel = document.getElementById('slideOverPanel');
        backdrop.style.display = 'flex';
        requestAnimationFrame(() => { panel.style.transform = 'translateX(0)'; });
    }

    function closePanel() {
        const panel = document.getElementById('slideOverPanel');
        const backdrop = document.getElementById('slideOverBackdrop');
        panel.style.transform = 'translateX(100%)';
        setTimeout(() => { backdrop.style.display = 'none'; }, 350);
    }

    async function confirmReservation() {
        const clientId = document.getElementById('resClientSelect').value;
        const start = document.getElementById('dateDepart').value;
        const end = document.getElementById('dateRetour').value;
        if (!clientId) { alert('Aucun client sélectionnable (liste clients pas encore chargée ou vide).'); return; }
        if (!selectedVehicleId) { alert('Sélectionnez un véhicule disponible.'); return; }
        if (!start || !end || new Date(end) <= new Date(start)) { alert('Sélectionnez une période valide.'); return; }

        const vehicle = getVehicle(selectedVehicleId);
        const total = vehicle.tarif * daysBetween(start, end);

        const { data, error } = await sb.from('reservations').insert({
            client_id: clientId,
            vehicle_id: selectedVehicleId,
            start_date: start,
            end_date: end,
            daily_rate: vehicle.tarif,
            total_due: total,
            status: 'CONFIRMED',
            created_by: currentStaffUserId,
        }).select().single();
        if (error) { alert('Erreur création réservation : ' + error.message); return; }

        await createContractForReservation(data.id);
        logActivity('Réservation confirmée', `${vehicle.model} pour ${getClient(clientId).name} (${daysBetween(start, end)} jours)`, 'bg-primary');
        closePanel();
        await Promise.all([loadReservations(), loadContracts()]);
        renderAll();
    }

    document.getElementById('dateDepart').addEventListener('change', renderVehicleOptionsForPanel);
    document.getElementById('dateRetour').addEventListener('change', renderVehicleOptionsForPanel);

    // ---- Clients CRUD (Supabase) --------------------------------------------
    let editingClientId = null;

    function resetClientForm() {
        ['newClientFirstName','newClientLastName','newClientPhone','newClientEmail','newClientLicenseNumber',
         'newClientLicenseExpiry','newClientCin','newClientAddress','newClientNotes'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('newClientRisk').value = 'LOW';
        document.getElementById('newClientVip').checked = false;
        document.getElementById('newClientBlacklisted').checked = false;
        document.getElementById('clientModalError').classList.add('hidden');
        const ocrFile = document.getElementById('clientOcrFile');
        const ocrStatus = document.getElementById('ocrStatusBox');
        const ocrResult = document.getElementById('ocrResultBox');
        const ocrText = document.getElementById('ocrExtractedText');
        if (ocrFile) ocrFile.value = '';
        if (ocrStatus) ocrStatus.classList.add('hidden');
        if (ocrResult) ocrResult.classList.add('hidden');
        if (ocrText) ocrText.textContent = '';
    }

    function openAddClientModal() {
        editingClientId = null;
        resetClientForm();
        document.getElementById('clientModalTitle').textContent = 'Nouveau Client';
        document.getElementById('clientModalSubmitBtn').textContent = 'Ajouter';
        document.getElementById('addClientModal').style.display = 'flex';
    }

    function openEditClientModal(clientId) {
        const c = getClient(clientId);
        editingClientId = clientId;
        resetClientForm();
        document.getElementById('newClientFirstName').value = c.first_name;
        document.getElementById('newClientLastName').value = c.last_name;
        document.getElementById('newClientPhone').value = c.phone === '—' ? '' : c.phone;
        document.getElementById('newClientEmail').value = c.email;
        document.getElementById('newClientLicenseNumber').value = c.license_number;
        document.getElementById('newClientLicenseExpiry').value = c.license_expiry;
        document.getElementById('newClientCin').value = c.cin_number;
        document.getElementById('newClientAddress').value = c.address;
        document.getElementById('newClientRisk').value = c.risk_level;
        document.getElementById('newClientNotes').value = c.notes;
        document.getElementById('newClientVip').checked = c.is_vip;
        document.getElementById('newClientBlacklisted').checked = c.is_blacklisted;
        document.getElementById('clientModalTitle').textContent = 'Modifier Client';
        document.getElementById('clientModalSubmitBtn').textContent = 'Enregistrer';
        document.getElementById('addClientModal').style.display = 'flex';
    }

    function closeAddClientModal() {
        document.getElementById('addClientModal').style.display = 'none';
        editingClientId = null;
    }

    function showClientModalError(msg) {
        const el = document.getElementById('clientModalError');
        el.textContent = msg;
        el.classList.remove('hidden');
    }

    async function submitClientForm() {
        const firstName = document.getElementById('newClientFirstName').value.trim();
        const lastName = document.getElementById('newClientLastName').value.trim();
        const phone = document.getElementById('newClientPhone').value.trim();
        const submitBtn = document.getElementById('clientModalSubmitBtn');
        document.getElementById('clientModalError').classList.add('hidden');

        if (!firstName || !lastName) {
            showClientModalError('Prénom et nom sont obligatoires.');
            return;
        }

        if (!sb) {
            showClientModalError("Connexion à la base de données indisponible. Ouvrez la page via le serveur local puis réessayez.");
            return;
        }

        const payload = {
            first_name: firstName,
            last_name: lastName,
            phone: phone || '',
            email: document.getElementById('newClientEmail').value.trim() || null,
            license_number: document.getElementById('newClientLicenseNumber').value.trim() || null,
            license_expiry: document.getElementById('newClientLicenseExpiry').value || null,
            cin_number: document.getElementById('newClientCin').value.trim() || null,
            address: document.getElementById('newClientAddress').value.trim() || null,
            risk_level: document.getElementById('newClientRisk').value,
            is_vip: document.getElementById('newClientVip').checked,
            is_blacklisted: document.getElementById('newClientBlacklisted').checked,
            notes: document.getElementById('newClientNotes').value.trim() || null,
        };

        submitBtn.disabled = true;
        submitBtn.textContent = editingClientId ? 'Enregistrement...' : 'Ajout...';

        try {
            const { error } = editingClientId
                ? await sb.from('clients').update(payload).eq('id', editingClientId)
                : await sb.from('clients').insert(payload);

            if (error) throw error;

            logActivity(editingClientId ? 'Client modifié' : 'Nouveau client ajouté', `${firstName} ${lastName}`, 'bg-primary');
            closeAddClientModal();
            await loadClients();
            renderAll();
        } catch (error) {
            console.error('Erreur sauvegarde client:', error);
            showClientModalError(error.message || "Impossible d'enregistrer le client pour le moment.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = editingClientId ? 'Enregistrer' : 'Ajouter';
        }
    }

    async function deleteClient(clientId) {
        const c = getClient(clientId);
        if (!c) return;
        if (!sb) {
            alert('Connexion à la base de données indisponible. Réessayez dans quelques instants.');
            return;
        }

        const localReservationCount = DB.reservations.filter(r => r.clientId === clientId).length;
        const { count, error: countError } = await sb
            .from('reservations')
            .select('id', { count: 'exact', head: true })
            .eq('client_id', clientId);

        if (countError) {
            console.error('Erreur vérification réservations client:', countError);
        }

        const reservationCount = countError ? localReservationCount : (count || 0);
        if (reservationCount > 0) {
            alert(`${c.name} ne peut pas être supprimé car ${reservationCount} réservation${reservationCount > 1 ? 's sont liées' : ' est liée'} à ce client. Son historique de location doit être conservé.`);
            return;
        }

        if (!confirm(`Supprimer ${c.name} ? Cette action est irréversible.`)) return;
        const { error } = await sb.from('clients').delete().eq('id', clientId);
        if (error) {
            if (error.code === '23503' || /foreign key|reservations_client_id_fkey/i.test(error.message || '')) {
                alert(`${c.name} ne peut pas être supprimé car des réservations sont liées à ce client. Son historique de location doit être conservé.`);
            } else {
                alert("Impossible de supprimer ce client pour le moment. Réessayez dans quelques instants.");
                console.error('Erreur suppression client:', error);
            }
            return;
        }
        logActivity('Client supprimé', c.name, 'bg-error');
        closeClientDetail();
        await loadClients();
    }

    // ---- Add Vehicle modal --------------------------------------------------
    function openAddVehicleModal() {
        document.getElementById('newVehicleModel').value = '';
        document.getElementById('newVehiclePlate').value = '';
        document.getElementById('newVehicleTarif').value = '';
        document.getElementById('newVehicleKm').value = '';
        document.getElementById('addVehicleModal').style.display = 'flex';
    }
    function closeAddVehicleModal() {
        document.getElementById('addVehicleModal').style.display = 'none';
    }
    async function submitNewVehicle() {
        const model = document.getElementById('newVehicleModel').value.trim();
        const plate = document.getElementById('newVehiclePlate').value.trim();
        const tarif = parseInt(document.getElementById('newVehicleTarif').value, 10);
        const km = parseInt(document.getElementById('newVehicleKm').value, 10) || 0;
        if (!model || !plate || !tarif) { alert('Modèle, plaque et tarif requis.'); return; }

        const { error } = await sb.from('vehicles').insert({
            model: model,
            plate_number: plate,
            category: 'Nouvelle unité',
            mileage_km: km,
            daily_rate: tarif,
            status: 'AVAILABLE',
        });
        if (error) { alert('Erreur ajout véhicule : ' + error.message); return; }

        logActivity('Véhicule ajouté à la flotte', `${model} (${plate})`, 'bg-primary');
        closeAddVehicleModal();
        await loadVehicles();
        renderAll();
    }

    // ---- Rendering: Contracts ---------------------------------------------------
    function renderContractSelector() {
        const select = document.getElementById('contractSelector');
        const emptyState = document.getElementById('contractEmptyState');
        const wrapper = document.getElementById('contractDetailWrapper');

        if (DB.contracts.length === 0) {
            select.innerHTML = '';
            emptyState.style.display = 'block';
            wrapper.style.display = 'none';
            return;
        }
        emptyState.style.display = 'none';
        wrapper.style.display = 'block';

        const sorted = [...DB.contracts].sort((a, b) => b.timeline[0].at - a.timeline[0].at);
        select.innerHTML = sorted.map(c => {
            const r = DB.reservations.find(x => x.id === c.reservationId);
            const client = getClient(r.clientId);
            return `<option value="${c.id}">${c.id} — ${client.name}</option>`;
        }).join('');

        if (!DB.contracts.some(c => c.id === selectedContractId)) {
            selectedContractId = sorted[0].id;
        }
        select.value = selectedContractId;
        renderContractDetail(selectedContractId);
    }

    const CONTRACT_STATUS_META = {
        DRAFT:     { label: 'Brouillon', cls: 'bg-surface-container-high text-on-surface-variant' },
        GENERATED: { label: 'Généré',    cls: 'bg-primary-container/10 text-primary' },
        SENT:      { label: 'Envoyé',    cls: 'bg-primary-container/10 text-primary' },
        ACTIVE:    { label: 'Actif',     cls: 'bg-secondary-container/20 text-on-secondary-container' },
        CLOSED:    { label: 'Clôturé',   cls: 'bg-surface-container-high text-on-surface-variant' },
        VOID:      { label: 'Annulé',    cls: 'bg-error-container/20 text-error' },
    };

    function renderContractDetail(contractId) {
        const contract = DB.contracts.find(c => c.id === contractId);
        if (!contract) return;
        selectedContractId = contractId;
        document.getElementById('contractSelector').value = contractId;

        const r = DB.reservations.find(x => x.id === contract.reservationId);
        const client = getClient(r.clientId);
        const vehicle = getVehicle(r.vehicleId);
        const nights = daysBetween(r.start, r.end);
        const sm = CONTRACT_STATUS_META[contract.status];

        document.getElementById('contractNumberDisplay').textContent = 'Contrat #' + contract.id;
        const badge = document.getElementById('contractStatusBadge');
        badge.textContent = sm.label;
        badge.className = `px-md py-xs ${sm.cls} rounded-full text-[12px] font-semibold border border-current/20 uppercase tracking-wider`;
        document.getElementById('contractReservationLink').textContent = `Voir la réservation liée #${r.id}`;

        document.getElementById('contractClientName').textContent = client.name;
        document.getElementById('contractClientPhone').textContent = client.phone;
        document.getElementById('contractVehicleName').textContent = vehicle.model;
        document.getElementById('contractVehiclePlate').textContent = `${vehicle.plate} • ${vehicle.category}`;
        document.getElementById('contractKm').textContent = vehicle.km.toLocaleString('fr-FR') + ' km';

        document.getElementById('contractPeriodStart').textContent = fmtDate(r.start);
        document.getElementById('contractPeriodEnd').textContent = fmtDate(r.end);
        document.getElementById('contractDurationText').textContent = `Durée totale : ${nights} jours`;
        const now = new Date();
        const elapsed = Math.min(100, Math.max(0, ((now - new Date(r.start)) / (new Date(r.end) - new Date(r.start))) * 100));
        document.getElementById('contractProgressBar').style.width = (r.status === 'CONFIRMED' ? 0 : (contract.status === 'CLOSED' ? 100 : elapsed)) + '%';

        document.getElementById('contractTarifLabel').textContent = `Tarif journalier (${nights}j × ${vehicle.tarif}€)`;
        document.getElementById('contractTarifAmount').textContent = `${vehicle.tarif * nights},00 €`;
        document.getElementById('contractExtrasAmount').textContent = '0,00 €';
        document.getElementById('contractTotalAmount').textContent = `${r.total},00 €`;

        const agencyBox = document.getElementById('contractAgencySignatureBox');
        const clientBox = document.getElementById('contractClientSignatureBox');
        const agencySignature = getStoredSignature(contract._pk, 'agency');
        const clientSignature = getStoredSignature(contract._pk, 'client');
        document.getElementById('contractClientSignatureLabel').textContent = `Signature Client (${client.name})`;
        if (agencySignature) {
            agencyBox.innerHTML = `<img src="${agencySignature}" alt="Signature de l'agence" class="w-full h-full object-contain bg-white"/>`;
            document.getElementById('contractAgencySignedText').textContent = `Signé électroniquement le ${fmtDateTime(contract.agencySignedAt)}`;
        } else {
            agencyBox.innerHTML = `<button onclick="openSignatureModal('${contract._pk}')" class="inline-flex items-center gap-xs px-md py-sm text-primary font-semibold hover:bg-primary/5 rounded-lg"><span class="material-symbols-outlined">draw</span>Signer le contrat</button>`;
            document.getElementById('contractAgencySignedText').textContent = 'Signature manuscrite requise';
        }
        if (clientSignature) {
            clientBox.innerHTML = `<img src="${clientSignature}" alt="Signature du client" class="w-full h-full object-contain bg-white"/>`;
            document.getElementById('contractClientSignedText').textContent = `Signé le ${fmtDateTime(contract.clientSignedAt)}`;
        } else {
            clientBox.innerHTML = `<button onclick="openSignatureModal('${contract._pk}')" class="inline-flex items-center gap-xs px-md py-sm text-primary font-semibold hover:bg-primary/5 rounded-lg"><span class="material-symbols-outlined">draw</span>Signer le contrat</button>`;
            document.getElementById('contractClientSignedText').textContent = 'Signature manuscrite requise';
        }

    }

    function viewContractForReservation(resId) {
        const contract = getContractByReservation(resId);
        if (!contract) return;
        showPage('contrats');
        renderContractDetail(contract.id);
    }

    function downloadContractPdf() {
        const contract = DB.contracts.find(c => c.id === selectedContractId);
        if (!contract) return;

        if (!window.jspdf) {
            alert("La librairie de génération PDF n'a pas pu se charger (vérifiez la connexion internet).");
            return;
        }

        const r = DB.reservations.find(x => x.id === contract.reservationId);
        if (!r) { alert('Réservation liée introuvable.'); return; }
        const client = getClient(r.clientId);
        const vehicle = getVehicle(r.vehicleId);
        const nights = daysBetween(r.start, r.end);

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        const pageWidth = doc.internal.pageSize.getWidth();
        let y = 20;

        // Header
        doc.setFontSize(18);
        doc.setFont(undefined, 'bold');
        doc.text('AutoLoc — Contrat de Location', 14, y);
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.text(`Contrat #${contract.id}`, pageWidth - 14, y, { align: 'right' });
        y += 6;
        doc.setDrawColor(200);
        doc.line(14, y, pageWidth - 14, y);
        y += 10;

        function row(label, value) {
            doc.setFont(undefined, 'bold');
            doc.setFontSize(10);
            doc.text(label, 14, y);
            doc.setFont(undefined, 'normal');
            doc.text(String(value), 70, y);
            y += 7;
        }

        doc.setFontSize(12);
        doc.setFont(undefined, 'bold');
        doc.text('Client', 14, y);
        y += 7;
        row('Nom :', client.name);
        row('Téléphone :', client.phone);
        row('Permis :', client.permis);
        y += 4;

        doc.setFontSize(12);
        doc.setFont(undefined, 'bold');
        doc.text('Véhicule', 14, y);
        y += 7;
        row('Modèle :', vehicle.model);
        row('Plaque :', vehicle.plate);
        row('Kilométrage départ :', vehicle.km.toLocaleString('fr-FR') + ' km');
        y += 4;

        doc.setFontSize(12);
        doc.setFont(undefined, 'bold');
        doc.text('Location', 14, y);
        y += 7;
        row('Période :', `${fmtDate(r.start)} → ${fmtDate(r.end)} (${nights} jours)`);
        row('Tarif journalier :', `${vehicle.tarif} €/jour`);
        row('Total :', `${r.total} €`);
        row('Statut :', STATUS_META[r.status] ? STATUS_META[r.status].label : r.status);
        y += 4;

        doc.setFontSize(12);
        doc.setFont(undefined, 'bold');
        doc.text('Signatures', 14, y);
        y += 7;
        const clientSignatureImage = getStoredSignature(contract._pk, 'client');
        const agencySignatureImage = getStoredSignature(contract._pk, 'agency');
        if (clientSignatureImage && agencySignatureImage) {
            doc.setFontSize(9);
            doc.setFont(undefined, 'bold');
            doc.text('Client', 14, y);
            doc.text('Agence', 108, y);
            y += 3;
            doc.addImage(clientSignatureImage, 'PNG', 14, y, 76, 28);
            doc.addImage(agencySignatureImage, 'PNG', 108, y, 76, 28);
            y += 33;
            doc.setFont(undefined, 'normal');
            doc.setFontSize(8);
            doc.text(fmtDateTime(contract.clientSignedAt), 14, y);
            doc.text(fmtDateTime(contract.agencySignedAt), 108, y);
            y += 6;
        } else {
            row('Client :', 'Signature manuscrite requise');
            row('Agence :', 'Signature manuscrite requise');
        }
        doc.save(`${contract.id}.pdf`);
    }

    async function resendContract() {
        const contract = DB.contracts.find(c => c.id === selectedContractId);
        if (!contract) return;
        const { error } = await sb.from('contract_events').insert({ contract_id: contract._pk, event: 'Renvoyé au client' });
        if (error) { alert('Erreur : ' + error.message); return; }
        await sb.from('contracts').update({ sent_at: new Date().toISOString() }).eq('id', contract._pk);
        alert(`Contrat ${contract.id} renvoyé au client.`);
        await loadContracts();
        renderContractDetail(contract.id);
    }

    async function voidContract() {
        const contract = DB.contracts.find(c => c.id === selectedContractId);
        if (!contract) return;
        if (contract.status === 'CLOSED') { alert('Un contrat déjà clôturé ne peut pas être annulé.'); return; }
        if (!confirm(`Annuler le contrat ${contract.id} ?`)) return;
        const { error } = await sb.from('contracts').update({ status: 'VOID' }).eq('id', contract._pk);
        if (error) { alert('Erreur : ' + error.message); return; }
        await sb.from('contract_events').insert({ contract_id: contract._pk, event: 'Contrat annulé manuellement' });
        await loadContracts();
        renderContractDetail(contract.id);
    }

    // ---- Client detail modal --------------------------------------------------
    let currentDetailClientId = null;
    function openClientDetail(clientId) {
        const c = getClient(clientId);
        currentDetailClientId = clientId;
        document.getElementById('clientDetailName').textContent = c.name;
        document.getElementById('clientDetailMeta').textContent = c.note;
        document.getElementById('clientDetailPhone').textContent = c.phone;
        document.getElementById('clientDetailPermis').textContent = c.permis;
        document.getElementById('clientDetailEmail').textContent = c.email || '—';
        document.getElementById('clientDetailAddress').textContent = c.address || '—';

        const badges = [];
        if (c.is_vip) badges.push('<span class="bg-secondary-container text-on-secondary-container text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tighter">VIP</span>');
        if (c.blacklisted) badges.push('<span class="bg-error text-white text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tighter">Blacklisté</span>');
        else if (c.risk_level === 'HIGH') badges.push('<span class="bg-error-container/30 text-error text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tighter">Risque élevé</span>');
        else if (c.risk_level === 'MEDIUM') badges.push('<span class="bg-tertiary-container/20 text-tertiary text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tighter">Signalé</span>');
        document.getElementById('clientDetailBadges').innerHTML = badges.join(' ');

        const resList = DB.reservations.filter(r => r.clientId === clientId).sort((a, b) => b.start < a.start ? -1 : 1);
        const container = document.getElementById('clientDetailReservations');
        if (resList.length === 0) {
            container.innerHTML = '<p class="text-caption text-on-surface-variant">Aucune réservation pour ce client.</p>';
        } else {
            container.innerHTML = resList.map(r => {
                const vehicle = getVehicle(r.vehicleId);
                const sm = STATUS_META[r.status];
                return `<div class="flex justify-between items-center p-sm bg-surface-container-low rounded-lg text-body-md">
                    <span>${vehicle.model} — ${fmtDate(r.start)} → ${fmtDate(r.end)}</span>
                    <span class="px-sm py-1 rounded ${sm.cls} font-bold text-[10px] uppercase">${sm.label}</span>
                </div>`;
            }).join('');
        }
        document.getElementById('clientDetailModal').style.display = 'flex';
    }
    function closeClientDetail() {
        document.getElementById('clientDetailModal').style.display = 'none';
    }

    // ---- Master render + boot --------------------------------------------------
    function renderAll() {
        detectOverdue();
        renderDashboard();
        renderClients();
        renderVehicles();
        renderReservations();
        renderContractSelector();
    }

    renderAll(); // first paint with empty state while the auth gate/data load

    (async function boot() {
        try {
            await initSupabase();

            // Keep the session alive across reloads: check for one immediately...
            const { data: { session } } = await sb.auth.getSession();
            if (session) { await onAuthenticated(session); } else { onUnauthenticated(); }

            // ...and react to every future login/logout, including token refresh.
            sb.auth.onAuthStateChange((_event, session) => {
                if (session) { onAuthenticated(session); } else { onUnauthenticated(); }
            });
        } catch (error) {
            console.error('Supabase boot error:', error);
            const authGate = document.getElementById('authGate');
            const authError = document.getElementById('authError');
            if (authGate) authGate.style.display = 'flex';
            if (authError) {
                authError.textContent = "Impossible de charger la connexion à la base de données. Ouvrez la page avec le serveur local et vérifiez la connexion internet.";
                authError.classList.remove('hidden');
            }
        }
    })();

    //  Notification Modal System (I did this, by my own)
    // Fixed: was id="openBtn"/single element, only existed on the Dashboard page.
    // Every page's bell now shares the class "notif-bell-btn" instead, so
    // querySelectorAll finds all of them and the same panel opens from any page.
    const notifMod = document.getElementById('notifMod');
    const closeBtn = document.getElementById('closeBtn');
    const notifBellBtns = document.querySelectorAll('.notif-bell-btn');

    notifBellBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            notifMod.classList.remove('hidden');
        });
    });
    closeBtn.addEventListener('click', () => {
        notifMod.classList.add('hidden');
    });

    // Bar System (I did this, by my own)
    // Fixed: was id="menuBtn", only existed in the Contrats page header, so it did
    // nothing anywhere else. Now every page's hamburger shares "menu-toggle-btn".
    // Also: toggling the sidebar used to leave a 260px empty gap, because every
    // page's header/main assumed the sidebar was always visible (ml-[260px] /
    // w-[calc(100%-260px)]) - toggling a class on <body> instead lets the CSS
    // rules added above (body.menu-collapsed ...) resize everything together.
    const menuToggleBtns = document.querySelectorAll('.menu-toggle-btn');

    menuToggleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            document.body.classList.toggle('menu-collapsed');
        });
    });

    // PWA installation and offline shell.
    let deferredPwaPrompt = null;
    const pwaInstallBtn = document.getElementById('pwaInstallBtn');
    const offlineBanner = document.getElementById('offlineBanner');

    function updateOnlineState() {
        const offline = !navigator.onLine;
        offlineBanner.classList.toggle('hidden', !offline);
        offlineBanner.classList.toggle('flex', offline);
    }

    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    updateOnlineState();

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        deferredPwaPrompt = event;
        pwaInstallBtn.classList.remove('hidden');
        pwaInstallBtn.classList.add('flex');
    });

    pwaInstallBtn.addEventListener('click', async () => {
        if (!deferredPwaPrompt) return;
        deferredPwaPrompt.prompt();
        await deferredPwaPrompt.userChoice;
        deferredPwaPrompt = null;
        pwaInstallBtn.classList.add('hidden');
        pwaInstallBtn.classList.remove('flex');
    });

    window.addEventListener('appinstalled', () => {
        deferredPwaPrompt = null;
        pwaInstallBtn.classList.add('hidden');
        pwaInstallBtn.classList.remove('flex');
    });

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch(error => {
                console.error('Service worker registration failed:', error);
            });
        });
    }


