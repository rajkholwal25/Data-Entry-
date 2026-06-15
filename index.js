// Enhanced interactivity for the Unit 1 (Holographic) Dashboard

document.addEventListener('DOMContentLoaded', function() {
    const machinesView = document.getElementById('home-view');
    const traceView = document.getElementById('traceability-view');
    const labelsView = document.getElementById('process-labels-view');
    const btnOpenTrace = document.getElementById('btn-open-trace');
    const btnOpenLabels = document.getElementById('btn-open-labels');
    const btnBackMachines = document.getElementById('btn-back-machines');
    const btnBackFromLabels = document.getElementById('btn-back-from-labels');
    const pageTitle = document.getElementById('page-main-title');
    const pageSubtitle = document.getElementById('page-subtitle');
    const headerActions = document.querySelector('.header-top-actions');

    function setHeaderButtonsVisible(visible) {
        if (headerActions) headerActions.style.display = visible ? '' : 'none';
    }

    function showMachinesView() {
        if (traceView) traceView.classList.add('hidden');
        if (labelsView) labelsView.classList.add('hidden');
        if (machinesView) machinesView.classList.remove('hidden');
        setHeaderButtonsVisible(true);
        if (pageTitle) pageTitle.textContent = 'Unit 1 - Holographic';
        if (pageSubtitle) pageSubtitle.textContent = 'Select a holographic process and machine to enter production data';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function showTraceView() {
        if (machinesView) machinesView.classList.add('hidden');
        if (labelsView) labelsView.classList.add('hidden');
        if (traceView) traceView.classList.remove('hidden');
        setHeaderButtonsVisible(false);
        if (pageTitle) pageTitle.textContent = 'Material Traceability';
        if (pageSubtitle) pageSubtitle.textContent = 'Search by PO or batch number to trace inputs and outputs';
        window.scrollTo({ top: 0, behavior: 'smooth' });
        if (typeof window.traceabilityRunFromParams === 'function') {
            window.traceabilityRunFromParams();
        }
    }

    function showLabelsView() {
        if (machinesView) machinesView.classList.add('hidden');
        if (traceView) traceView.classList.add('hidden');
        if (labelsView) labelsView.classList.remove('hidden');
        setHeaderButtonsVisible(false);
        if (pageTitle) pageTitle.textContent = 'Process Labels';
        if (pageSubtitle) pageSubtitle.textContent = 'Load a PO — select each output batch to preview and print its label';
        window.scrollTo({ top: 0, behavior: 'smooth' });
        if (typeof window.processLabelsRunFromParams === 'function') {
            window.processLabelsRunFromParams();
        }
    }

    if (btnOpenTrace) btnOpenTrace.addEventListener('click', showTraceView);
    if (btnOpenLabels) btnOpenLabels.addEventListener('click', showLabelsView);
    if (btnBackMachines) btnBackMachines.addEventListener('click', showMachinesView);
    if (btnBackFromLabels) btnBackFromLabels.addEventListener('click', showMachinesView);

    window.showHomeMachinesView = showMachinesView;
    window.showProcessLabelsView = showLabelsView;

    const params = new URLSearchParams(location.search);
    if (params.get('view') === 'labels' || params.get('label') || params.get('labelPo')) {
        showLabelsView();
    } else if (params.get('view') === 'trace' || params.get('po') || params.get('batch')) {
        showTraceView();
    }

    // Add ripple effect to machine items
    const machineItems = document.querySelectorAll('.machine-item');

    machineItems.forEach(item => {
        item.addEventListener('click', function(e) {
            const ripple = document.createElement('span');
            const rect = this.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = e.clientX - rect.left - size / 2;
            const y = e.clientY - rect.top - size / 2;

            ripple.style.width = ripple.style.height = size + 'px';
            ripple.style.left = x + 'px';
            ripple.style.top = y + 'px';
            ripple.classList.add('ripple');

            this.appendChild(ripple);

            const process = new URLSearchParams(this.href.split('?')[1]).get('process');
            const machine = new URLSearchParams(this.href.split('?')[1]).get('machine');

            if (process) localStorage.setItem('lastSelectedProcess', process);
            if (machine) localStorage.setItem('lastSelectedMachine', machine);
            localStorage.setItem('lastSelectionTime', new Date().toISOString());

            setTimeout(() => ripple.remove(), 600);
        });

        item.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.click();
            }
        });
    });

    const processCards = document.querySelectorAll('.process-card');

    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);

    processCards.forEach(card => {
        observer.observe(card);
    });

    const lastMachine = localStorage.getItem('lastSelectedMachine');
    const lastTime = localStorage.getItem('lastSelectionTime');

    if (lastMachine && lastTime) {
        const timeDiff = Date.now() - new Date(lastTime).getTime();
        const hoursDiff = timeDiff / (1000 * 60 * 60);

        if (hoursDiff < 8) {
            const machineElement = document.getElementById(lastMachine);
            if (machineElement) {
                machineElement.style.borderColor = 'rgba(102, 126, 234, 0.5)';
                machineElement.style.background = 'rgba(102, 126, 234, 0.1)';

                const indicator = document.createElement('span');
                indicator.textContent = '⭐';
                indicator.style.marginLeft = '8px';
                indicator.style.fontSize = '0.875rem';
                indicator.title = 'Recently used';
                machineElement.querySelector('.machine-name').appendChild(indicator);
            }
        }
    }

    document.documentElement.style.scrollBehavior = 'smooth';

    machineItems.forEach((item) => {
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `Navigate to ${item.querySelector('.machine-name').textContent.trim()} data entry`);
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'h' || e.key === 'H') {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });

    machineItems.forEach(item => {
        item.addEventListener('click', function() {
            this.style.opacity = '0.6';
            this.style.pointerEvents = 'none';
        });
    });

    console.log('Post Press Dashboard initialized successfully');
    console.log('Total machines available:', machineItems.length);
});

const style = document.createElement('style');
style.textContent = `
    .machine-item {
        position: relative;
        overflow: hidden;
    }

    .ripple {
        position: absolute;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.3);
        transform: scale(0);
        animation: ripple-animation 0.6s ease-out;
        pointer-events: none;
    }

    @keyframes ripple-animation {
        to {
            transform: scale(2);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);
