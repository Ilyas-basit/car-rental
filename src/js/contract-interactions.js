
        // Contrat: button icon pulse micro-interaction, scoped to this page
        (function() {
            const root = document.getElementById('page-root-contrats');
            root.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', function() {
                    const icon = this.querySelector('.material-symbols-outlined');
                    if (icon) {
                        icon.style.transform = 'scale(1.2)';
                        setTimeout(() => icon.style.transform = 'scale(1)', 200);
                    }
                });
            });
        })();


