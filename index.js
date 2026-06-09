// Enhanced interactivity for the Post Press Dashboard

const BRANCH_STORAGE_KEY = 'selectedBranch';

function switchBranch(branch) {
    const unit1 = document.getElementById('unit-1-machines');
    const unit2 = document.getElementById('unit-2-machines');
    const subtitle = document.querySelector('.subtitle');

    if (!unit1 || !unit2) return;

    const isUnit1 = branch === 'unit-1';
    unit1.hidden = !isUnit1;
    unit2.hidden = isUnit1;

    if (subtitle) {
        subtitle.textContent = isUnit1
            ? 'Select a holographic process and machine to enter production data'
            : 'Select a process and machine to enter production data';
    }

    localStorage.setItem(BRANCH_STORAGE_KEY, branch);
}

document.addEventListener('DOMContentLoaded', function() {
    const branchSelect = document.getElementById('branch-select');
    const savedBranch = localStorage.getItem(BRANCH_STORAGE_KEY) || 'unit-2';

    if (branchSelect) {
        branchSelect.value = savedBranch;
        switchBranch(savedBranch);
        branchSelect.addEventListener('change', function() {
            switchBranch(this.value);
        });
    }

    // Add ripple effect to machine items
    const machineItems = document.querySelectorAll('.machine-item');
    
    machineItems.forEach(item => {
        item.addEventListener('click', function(e) {
            // Create ripple effect
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
            
            // Store selection in localStorage for potential use
            const process = new URLSearchParams(this.href.split('?')[1]).get('process');
            const machine = new URLSearchParams(this.href.split('?')[1]).get('machine');
            
            if (process) localStorage.setItem('lastSelectedProcess', process);
            if (machine) localStorage.setItem('lastSelectedMachine', machine);
            localStorage.setItem('lastSelectionTime', new Date().toISOString());
            
            setTimeout(() => ripple.remove(), 600);
        });
        
        // Add keyboard navigation
        item.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.click();
            }
        });
    });
    
    // Add process card animations on scroll
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
    
    // Add dynamic time-based greeting
    const subtitle = document.querySelector('.subtitle');
    const hour = new Date().getHours();
    let greeting = '';
    
    if (hour < 12) {
        greeting = 'Good Morning! ';
    } else if (hour < 17) {
        greeting = 'Good Afternoon! ';
    } else {
        greeting = 'Good Evening! ';
    }
    
    // Highlight recently used machine
    const lastMachine = localStorage.getItem('lastSelectedMachine');
    const lastTime = localStorage.getItem('lastSelectionTime');
    
    if (lastMachine && lastTime) {
        const timeDiff = Date.now() - new Date(lastTime).getTime();
        const hoursDiff = timeDiff / (1000 * 60 * 60);
        
        // If accessed within last 8 hours, highlight it
        if (hoursDiff < 8) {
            const machineElement = document.getElementById(lastMachine);
            if (machineElement) {
                machineElement.style.borderColor = 'rgba(102, 126, 234, 0.5)';
                machineElement.style.background = 'rgba(102, 126, 234, 0.1)';
                
                // Add a "recently used" indicator
                const indicator = document.createElement('span');
                indicator.textContent = '⭐';
                indicator.style.marginLeft = '8px';
                indicator.style.fontSize = '0.875rem';
                indicator.title = 'Recently used';
                machineElement.querySelector('.machine-name').appendChild(indicator);
            }
        }
    }
    
    // Add smooth scroll behavior
    document.documentElement.style.scrollBehavior = 'smooth';
    
    // Add focus management for accessibility
    machineItems.forEach((item, index) => {
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `Navigate to ${item.querySelector('.machine-name').textContent.trim()} data entry`);
    });
    
    // Add keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        // Press 'H' to scroll to top
        if (e.key === 'h' || e.key === 'H') {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });
    
    // Add loading state management
    machineItems.forEach(item => {
        item.addEventListener('click', function(e) {
            // Visual feedback that navigation is happening
            this.style.opacity = '0.6';
            this.style.pointerEvents = 'none';
        });
    });
    
    console.log('Post Press Dashboard initialized successfully');
    console.log('Total machines available:', machineItems.length);
});

// Add ripple animation styles dynamically
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
