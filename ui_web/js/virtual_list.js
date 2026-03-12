export class VirtualList {
    constructor(container, options) {
        this.container = container;
        this.options = options;
        this.itemHeight = options.itemHeight || 76; // 76px roughly for mobile row
        this.items = options.items || [];
        this.renderItem = options.renderItem;
        this.overscan = options.overscan || 10;
        
        this.scrollContainer = this.container.closest('.view') || this.container;
        this.viewportHeight = this.scrollContainer.clientHeight || window.innerHeight;
        this.totalHeight = this.items.length * this.itemHeight;
        
        this.innerContainer = document.createElement('div');
        this.innerContainer.style.height = `${this.totalHeight}px`;
        this.innerContainer.style.position = 'relative';
        this.innerContainer.style.width = '100%';
        
        this.container.innerHTML = '';
        this.container.appendChild(this.innerContainer);
        
        this.renderedNodes = new Map();
        
        this.onScroll = this.onScroll.bind(this);
        this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });
        window.addEventListener('resize', () => {
            this.viewportHeight = this.scrollContainer.clientHeight || window.innerHeight;
            this.onScroll();
        }, { passive: true });
        
        this.render();
    }

    updateData(newItems) {
        this.items = newItems || [];
        this.totalHeight = this.items.length * this.itemHeight;
        this.innerContainer.style.height = `${this.totalHeight}px`;
        
        // Ensure the innerContainer is still attached (e.g., if someone set innerHTML = '')
        if (this.innerContainer.parentNode !== this.container) {
            this.container.innerHTML = '';
            this.container.appendChild(this.innerContainer);
            this.renderedNodes.clear(); // Clear memory map as DOM nodes were wiped
        }
        
        this.render();
    }

    onScroll() {
        requestAnimationFrame(() => this.render());
    }

    render() {
        let scrollTop = this.scrollContainer.scrollTop || 0;
        
        // Account for the offset of the container relative to the scrollContainer
        let offsetTop = 0;
        let currEl = this.container;
        while (currEl && currEl !== this.scrollContainer) {
            offsetTop += currEl.offsetTop || 0;
            currEl = currEl.offsetParent;
        }
        
        let adjustedScrollTop = Math.max(0, scrollTop - offsetTop);

        const startIndex = Math.max(0, Math.floor(adjustedScrollTop / this.itemHeight) - this.overscan);
        const endIndex = Math.min(this.items.length - 1, Math.ceil((adjustedScrollTop + this.viewportHeight) / this.itemHeight) + this.overscan);
        
        const indicesToKeep = new Set();
        for (let i = startIndex; i <= endIndex; i++) {
            indicesToKeep.add(i);
            if (!this.renderedNodes.has(i)) {
                const html = this.renderItem(this.items[i], i);
                const wrapper = document.createElement('div');
                wrapper.innerHTML = html.trim();
                const node = wrapper.firstElementChild;
                node.style.position = 'absolute';
                node.style.top = `${i * this.itemHeight}px`;
                node.style.width = '100%';
                // Inherit some row margins if needed
                node.style.marginBottom = '0'; 
                this.innerContainer.appendChild(node);
                this.renderedNodes.set(i, node);
            }
        }
        
        for (const [index, node] of this.renderedNodes.entries()) {
            if (!indicesToKeep.has(index)) {
                node.remove();
                this.renderedNodes.delete(index);
            }
        }
    }
    
    destroy() {
        this.scrollContainer.removeEventListener('scroll', this.onScroll);
        this.container.innerHTML = '';
        this.renderedNodes.clear();
    }
}
