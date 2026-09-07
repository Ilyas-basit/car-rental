

        // --- Page navigation (SPA-style show/hide) ---
        const PAGES = ['dashboard', 'clients', 'vehicules', 'reservations', 'contrats'];

        function showPage(name) {
            PAGES.forEach(p => {
                const el = document.getElementById('page-root-' + p);
                if (el) el.style.display = (p === name) ? 'block' : 'none';
            });
            document.querySelectorAll('#main-nav .nav-link').forEach(link => {
                const active = link.getAttribute('data-page') === name;
                link.classList.toggle('border-l-4', active);
                link.classList.toggle('border-primary', active);
                link.classList.toggle('bg-primary-container/10', active);
                link.classList.toggle('text-surface-bright', active);
                link.classList.toggle('font-semibold', active);
                link.classList.toggle('text-surface-variant', !active);
            });
        }


