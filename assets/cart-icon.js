import { Component } from '@theme/component';
import { onAnimationEnd } from '@theme/utilities';
import { ThemeEvents } from '@theme/events';
import { StandardEvents, CartLinesUpdateEvent } from '@shopify/events';

/**
 * A custom element that displays a cart icon.
 *
 * @typedef {object} Refs
 * @property {HTMLElement} cartBubble - The cart bubble element.
 * @property {HTMLElement} cartBubbleText - The cart bubble text element.
 * @property {HTMLElement} cartBubbleCount - The cart bubble count element.
 *
 * @extends {Component<Refs>}
 */
class CartIcon extends Component {
  requiredRefs = ['cartBubble', 'cartBubbleText', 'cartBubbleCount'];

  /** @type {number} */
  get currentCartCount() {
    return parseInt(this.refs.cartBubbleCount.textContent ?? '0', 10);
  }

  set currentCartCount(value) {
    this.refs.cartBubbleCount.textContent = value < 100 ? String(value) : '';
  }

  connectedCallback() {
    super.connectedCallback();

    document.addEventListener(StandardEvents.cartLinesUpdate, this.onCartUpdate);
    window.addEventListener('pageshow', this.onPageShow);
    this.ensureCartBubbleIsCorrect();
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    document.removeEventListener(StandardEvents.cartLinesUpdate, this.onCartUpdate);
    window.removeEventListener('pageshow', this.onPageShow);
  }

  /**
   * Handles the page show event when the page is restored from cache.
   * @param {PageTransitionEvent} event - The page show event.
   */
  onPageShow = (event) => {
    if (event.persisted) {
      this.ensureCartBubbleIsCorrect();
    }
  };

  /**
   * Handles the cart update event.
   * @param {CartLinesUpdateEvent} event - The cart update event.
   */
  onCartUpdate = (event) => {
    event.promise
      ?.then(({ cart, detail }) => {
        const itemCount = cart?.totalQuantity ?? detail?.itemCount ?? 0;

        this.renderCartBubble(itemCount);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[cart-icon] Event promise rejected:', error);
      });
  };

  /**
   * Renders the cart bubble.
   * @param {number} itemCount - The absolute number of items in the cart.
   * @param {boolean} [animate=true] - Whether to animate the bubble.
   */
  renderCartBubble = async (itemCount, animate = true) => {
    this.refs.cartBubbleCount.classList.toggle('hidden', itemCount === 0);
    this.refs.cartBubble.classList.toggle('visually-hidden', itemCount === 0);

    this.currentCartCount = itemCount;

    this.classList.toggle('header-actions__cart-icon--has-cart', itemCount > 0);

    sessionStorage.setItem(
      'cart-count',
      JSON.stringify({
        value: String(this.currentCartCount),
        timestamp: Date.now(),
      })
    );

    if (!animate || itemCount === 0) return;

    // Ensure element is visible before starting animation
    // Use requestAnimationFrame to ensure the browser sees the state change
    await new Promise((resolve) => requestAnimationFrame(resolve));

    this.refs.cartBubble.classList.add('cart-bubble--animating');
    await onAnimationEnd(this.refs.cartBubbleText);

    this.refs.cartBubble.classList.remove('cart-bubble--animating');
  };

  /**
   * Checks if the cart count is correct.
   */
  ensureCartBubbleIsCorrect = async () => {
    // Ensure refs are available
    if (!this.refs.cartBubbleCount) return;

    const sessionStorageCount = sessionStorage.getItem('cart-count');

    if (sessionStorageCount !== null) {
      try {
        const { value } = JSON.parse(sessionStorageCount);
        const count = parseInt(value, 10);
        if (!isNaN(count) && count >= 0) {
          this.renderCartBubble(count, false);
        }
      } catch (_) {
        // no-op
      }
    }

    try {
      const response = await fetch(`${window.Shopify?.routes?.root || '/'}cart.js`);
      if (response.ok) {
        const cart = await response.json();
        const itemCount = cart.item_count ?? cart.total_quantity ?? 0;
        this.renderCartBubble(itemCount, false);
      }
    } catch (_) {
      // no-op
    }
  };
}

if (!customElements.get('cart-icon')) {
  customElements.define('cart-icon', CartIcon);
}
