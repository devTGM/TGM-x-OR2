import { Component } from '@theme/component';
import { morph } from '@theme/morph';
import { DialogComponent, DialogCloseEvent } from '@theme/dialog';
import { mediaQueryLarge, isMobileBreakpoint, getIOSVersion } from '@theme/utilities';
import VariantPicker from '@theme/variant-picker';
import { StandardEvents, ProductSelectEvent, CartLinesUpdateEvent } from '@shopify/events';

export class QuickAddComponent extends Component {
  /** @type {AbortController | null} */
  #abortController = null;
  /** @type {Map<string, Element>} */
  #cachedContent = new Map();
  /** @type {AbortController} */
  #cartUpdateAbortController = new AbortController();

  get productPageUrl() {
    const productCard = /** @type {import('./product-card').ProductCard | null} */ (this.closest('product-card'));
    if (productCard) return productCard.productPageUrl;

    const hotspotProduct = /** @type {import('./product-hotspot').ProductHotspotComponent | null} */ (
      this.closest('product-hotspot-component')
    );
    const productLink = hotspotProduct?.getHotspotProductLink();

    return productLink?.href || '';
  }

  /**
   * Gets the currently selected variant ID from the product card
   * @returns {string | null} The variant ID or null
   */
  #getSelectedVariantId() {
    const productCard = /** @type {import('./product-card').ProductCard | null} */ (this.closest('product-card'));
    return productCard?.getSelectedVariantId() ?? null;
  }

  connectedCallback() {
    super.connectedCallback();

    mediaQueryLarge.addEventListener('change', this.#closeQuickAddModal);
    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartUpdate, {
      signal: this.#cartUpdateAbortController.signal,
    });
    document.addEventListener(StandardEvents.productSelect, this.#handleProductSelectUpdate);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    mediaQueryLarge.removeEventListener('change', this.#closeQuickAddModal);
    this.#abortController?.abort();
    this.#cartUpdateAbortController.abort();
    document.removeEventListener(StandardEvents.productSelect, this.#handleProductSelectUpdate);
  }

  /**
   * Updates quick-add button state when product variant is selected
   * @param {ProductSelectEvent} event - The product select event
   */
  #handleProductSelectUpdate = (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest('product-card') !== this.closest('product-card')) return;
    if (this.dataset.usesSellingPlans === 'true') return;

    // Only flip choose <-> add when both buttons were rendered.
    // Otherwise the flip would hide the sole rendered button and reveal nothing.
    if (this.dataset.rendersBothButtons !== 'true') return;

    const productOptionsCount = this.dataset.productOptionsCount;
    let quickAddButton = productOptionsCount === '1' ? 'add' : 'choose';

    // A single-option card can resolve to an unavailable variant (e.g. re-selecting a
    // sold-out swatch). Keep "Choose" so shoppers reach the picker, not a dead-end disabled "Add".
    if (quickAddButton === 'add' && this.#isSelectedVariantUnavailable()) {
      quickAddButton = 'choose';
    }

    this.setAttribute('data-quick-add-button', quickAddButton);
  };

  /**
   * Whether the card's currently selected swatch maps to an unavailable variant.
   * Reads `data-option-available` off the variant picker's selected option - the same
   * signal the product card uses. Only reports true on an explicit `false`, so an
   * unknown/absent signal leaves the caller's default ("add") untouched.
   * @returns {boolean}
   */
  #isSelectedVariantUnavailable() {
    const productCard = /** @type {import('./product-card').ProductCard | null} */ (this.closest('product-card'));
    return productCard?.variantPicker?.selectedOption?.dataset.optionAvailable === 'false';
  }

  /**
   * Clears the cached content when cart is updated
   */
  #handleCartUpdate = () => {
    this.#cachedContent.clear();
  };

  /**
   * Re-renders the variant picker in the quick-add modal.
   * @param {Element} newHtml - The element to re-render.
   */
  #updateVariantPicker(newHtml) {
    const modalContent = document.getElementById('quick-add-modal-content');
    if (!modalContent) return;
    const variantPicker = /** @type {VariantPicker | null} */ (modalContent.querySelector('variant-picker'));
    if (!variantPicker) return;
    variantPicker.updateVariantPicker(newHtml);
  }

  /**
   * Handles quick add button click
   * @param {Event} event - The click event
   */
  handleClick = async (event) => {
    event.preventDefault();

    const currentUrl = this.productPageUrl;

    if (this.dataset.usesSellingPlans === 'true') {
      if (currentUrl) window.location.href = currentUrl;
      return;
    }

    // Check if we have cached content for this URL
    let productGrid = this.#cachedContent.get(currentUrl);

    if (!productGrid) {
      // Fetch and cache the content
      const html = await this.fetchProductPage(currentUrl);
      if (html) {
        const gridElement = html.querySelector('[data-product-grid-content]');
        if (gridElement) {
          // Cache the cloned element to avoid modifying the original
          productGrid = /** @type {Element} */ (gridElement.cloneNode(true));
          this.#cachedContent.set(currentUrl, productGrid);
        }
      }
    }

    if (productGrid) {
      // Use a fresh clone from the cache
      const freshContent = /** @type {Element} */ (productGrid.cloneNode(true));
      await this.updateQuickAddModal(freshContent);
      this.#updateVariantPicker(productGrid);
    }

    this.#openQuickAddModal();
  };

  #resetScroll() {
    const dialogComponent = document.getElementById('quick-add-dialog');
    if (!(dialogComponent instanceof QuickAddDialog)) return;

    const productDetails = dialogComponent.querySelector('.product-details');
    const productMedia = dialogComponent.querySelector('.product-information__media');
    productDetails?.scrollTo({ top: 0, behavior: 'instant' });
    productMedia?.scrollTo({ top: 0, behavior: 'instant' });
  }

  /** @param {QuickAddDialog} dialogComponent */
  #stayVisibleUntilDialogCloses(dialogComponent) {
    this.toggleAttribute('stay-visible', true);

    dialogComponent.addEventListener(DialogCloseEvent.eventName, () => this.toggleAttribute('stay-visible', false), {
      once: true,
    });
  }

  #openQuickAddModal = () => {
    const dialogComponent = document.getElementById('quick-add-dialog');
    if (!(dialogComponent instanceof QuickAddDialog)) return;

    this.#stayVisibleUntilDialogCloses(dialogComponent);

    dialogComponent.showDialog();

    // is nondeterministic when the open attribute is set on the dialog element after .showDialog() is called.
    // Waiting until the open animation starts seemed to be the most reliable metric here.
    const dialog = dialogComponent.refs?.dialog;
    if (!dialog) return;
    dialog.addEventListener('animationstart', this.#resetScroll.bind(this), { once: true });
  };

  #closeQuickAddModal = () => {
    const dialogComponent = document.getElementById('quick-add-dialog');
    if (!(dialogComponent instanceof QuickAddDialog)) return;

    dialogComponent.closeDialog();
  };

  /**
   * Fetches the product page content
   * @param {string} productPageUrl - The URL of the product page to fetch
   * @returns {Promise<Document | null>}
   */
  async fetchProductPage(productPageUrl) {
    if (!productPageUrl) return null;

    // We use this to abort the previous fetch request if it's still pending.
    this.#abortController?.abort();
    this.#abortController = new AbortController();

    try {
      const response = await fetch(productPageUrl, {
        signal: this.#abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch product page: HTTP error ${response.status}`);
      }

      const responseText = await response.text();
      const html = new DOMParser().parseFromString(responseText, 'text/html');

      return html;
    } catch (error) {
      if (error.name === 'AbortError') {
        return null;
      } else {
        throw error;
      }
    } finally {
      this.#abortController = null;
    }
  }

  /**
   * Re-renders the variant picker.
   * @param {Element} productGrid - The product grid element
   */
  async updateQuickAddModal(productGrid) {
    const modalContent = document.getElementById('quick-add-modal-content');

    if (!productGrid || !modalContent) return;

    if (isMobileBreakpoint()) {
      const productDetails = productGrid.querySelector('.product-details');
      const productFormComponent = productGrid.querySelector('product-form-component');
      const variantPicker = productGrid.querySelector('variant-picker');
      const productPrice = productGrid.querySelector('product-price');
      const productTitle = document.createElement('a');
      productTitle.textContent = this.dataset.productTitle || '';

      // Make product title as a link to the product page
      productTitle.href = this.productPageUrl;

      const productHeader = document.createElement('div');
      productHeader.classList.add('product-header');

      productHeader.appendChild(productTitle);
      if (productPrice) {
        productHeader.appendChild(productPrice);
      }
      productGrid.appendChild(productHeader);

      if (variantPicker) {
        productGrid.appendChild(variantPicker);
      }
      if (productFormComponent) {
        productGrid.appendChild(productFormComponent);
      }

      productDetails?.remove();
    }

    // Sync the view-event-payload attribute and morph children into the modal's product-component
    const payload = productGrid.getAttribute('view-event-payload') || '';
    modalContent.setAttribute('view-event-payload', payload);

    morph(modalContent, productGrid);

    this.#syncVariantSelection(modalContent);
  }

  /**
   * Syncs the variant selection from the product card to the modal
   * @param {Element} modalContent - The modal content element
   */
  #syncVariantSelection(modalContent) {
    const selectedVariantId = this.#getSelectedVariantId();
    if (!selectedVariantId) return;

    // Find and check the corresponding input in the modal
    const modalInputs = modalContent.querySelectorAll('input[type="radio"][data-variant-id]');
    for (const input of modalInputs) {
      if (input instanceof HTMLInputElement && input.dataset.variantId === selectedVariantId && !input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }
  }
}

if (!customElements.get('quick-add-component')) {
  customElements.define('quick-add-component', QuickAddComponent);
}

class QuickAddDialog extends DialogComponent {
  #abortController = new AbortController();

  connectedCallback() {
    super.connectedCallback();

    this.addEventListener(StandardEvents.cartLinesUpdate, this.handleCartUpdate, {
      signal: this.#abortController.signal,
    });
    this.addEventListener(StandardEvents.productSelect, this.#handleProductSelect);

    this.addEventListener(DialogCloseEvent.eventName, this.#handleDialogClose);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.#abortController.abort();
    this.removeEventListener(DialogCloseEvent.eventName, this.#handleDialogClose);
  }

  /**
   * Closes the dialog on successful cart update
   * @param {CartLinesUpdateEvent} event - The cart lines update event
   */
  handleCartUpdate = (event) => {
    event.promise
      ?.then(({ detail }) => {
        if (detail?.didError) return;
        this.closeDialog();
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[quick-add] Event promise rejected:', error);
      });
  };

  /** @param {ProductSelectEvent} event - The product select event */
  #handleProductSelect = (event) => {
    // Wait for variant update data
    event.promise
      .then(({ detail }) => {
        if (!detail?.html) return;

        const { html } = detail;
        const anchorElement = /** @type {HTMLAnchorElement} */ (html.querySelector('.view-product-title a'));
        const viewMoreDetailsLink = /** @type {HTMLAnchorElement} */ (this.querySelector('.view-product-title a'));
        const mobileProductTitle = /** @type {HTMLAnchorElement} */ (this.querySelector('.product-header a'));

        if (!anchorElement) return;

        if (viewMoreDetailsLink) viewMoreDetailsLink.href = anchorElement.href;
        if (mobileProductTitle) mobileProductTitle.href = anchorElement.href;
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[quick-add] Event promise rejected:', error);
      });
  };

  #handleDialogClose = () => {
    const iosVersion = getIOSVersion();
    /**
     * This is a patch to solve an issue with the UI freezing when the dialog is closed.
     * To reproduce it, use iOS 16.0.
     */
    if (!iosVersion || iosVersion.major >= 17 || (iosVersion.major === 16 && iosVersion.minor >= 4)) return;

    requestAnimationFrame(() => {
      /** @type {HTMLElement | null} */
      const grid = document.querySelector('#ResultsList [product-grid-view]');
      if (grid) {
        const currentWidth = grid.getBoundingClientRect().width;
        grid.style.width = `${currentWidth - 1}px`;
        requestAnimationFrame(() => {
          grid.style.width = '';
        });
      }
    });
  };
}

if (!customElements.get('quick-add-dialog')) {
  customElements.define('quick-add-dialog', QuickAddDialog);
}
/**
 * ON REPEAT MOBILE QUICK ADD
 * Desktop keeps the theme's native Quick Add.
 * Mobile opens a size + fit bottom sheet.
 */
(() => {
  'use strict';

  if (window.__ON_REPEAT_MOBILE_QUICK_ADD__) return;
  window.__ON_REPEAT_MOBILE_QUICK_ADD__ = true;

  const MOBILE_QUERY = '(max-width: 749px)';
  const SIZES = ['S', 'M', 'L', 'XL'];

  const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;

  const normalize = (value) =>
    String(value ?? '').trim().toLowerCase();

  const formatMoney = (amount) => {
    const currency = window.Shopify?.currency?.active || 'INR';

    try {
      return new Intl.NumberFormat(
        document.documentElement.lang || 'en-IN',
        {
          style: 'currency',
          currency,
          maximumFractionDigits: 0,
        }
      ).format(Number(amount || 0) / 100);
    } catch {
      return `₹${Math.round(
        Number(amount || 0) / 100
      ).toLocaleString('en-IN')}`;
    }
  };

  const getProductUrl = (quickAdd) => {
    const url = quickAdd?.productPageUrl || '';

    if (!url) return '';

    try {
      const parsed = new URL(url, window.location.origin);

      parsed.search = '';
      parsed.hash = '';

      return parsed.href.replace(/\/$/, '');
    } catch {
      return url;
    }
  };

  const createSheet = () => {
    if (document.getElementById('on-repeat-mobile-quick-add')) {
      return document.getElementById(
        'on-repeat-mobile-quick-add'
      );
    }

    const style = document.createElement('style');

    style.id = 'on-repeat-mobile-quick-add-styles';

    style.textContent = `
      #on-repeat-mobile-quick-add {
        display: none;
      }
        @media (max-width: 749px) {

  .quick-add {
    display: none !important;
  }

  .quick-add__button {
    display: none !important;
  }

}

      @media (max-width: 749px) {

        #on-repeat-mobile-quick-add {
          position: fixed;
          inset: 0;
          z-index: 999999;
          display: flex;
          align-items: flex-end;
          justify-content: center;
          pointer-events: none;
          font-family: inherit;
        }

        #on-repeat-mobile-quick-add.is-open {
          pointer-events: auto;
        }

        #on-repeat-mobile-quick-add .or-mqa-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, .34);
          opacity: 0;
          transition: opacity .25s ease;
        }

        #on-repeat-mobile-quick-add.is-open
        .or-mqa-backdrop {
          opacity: 1;
        }

        #on-repeat-mobile-quick-add .or-mqa-sheet {
          position: relative;
          width: 100%;
          max-height: 91vh;
          overflow-y: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          box-sizing: border-box;
          background: #fff;
          color: #1f1f1f;
          padding: 24px 18px 22px;
          transform: translateY(100%);
          transition:
            transform .3s cubic-bezier(.2,.75,.25,1);
          box-shadow:
            0 -12px 40px rgba(0,0,0,.12);
        }

        #on-repeat-mobile-quick-add.is-open
        .or-mqa-sheet {
          transform: translateY(0);
        }

        #on-repeat-mobile-quick-add .or-mqa-close {
          position: absolute;
          top: 10px;
          right: 10px;
          width: 42px;
          height: 42px;
          padding: 0;
          border: 0;
          background: transparent;
          cursor: pointer;
          z-index: 2;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-close::before,
        #on-repeat-mobile-quick-add
        .or-mqa-close::after {
          content: '';
          position: absolute;
          top: 20px;
          left: 9px;
          width: 24px;
          height: 1.5px;
          background: #111;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-close::before {
          transform: rotate(45deg);
        }

        #on-repeat-mobile-quick-add
        .or-mqa-close::after {
          transform: rotate(-45deg);
        }

        #on-repeat-mobile-quick-add .or-mqa-product {
          display: grid;
          grid-template-columns:
            minmax(0, 42%)
            minmax(0, 1fr);
          gap: 18px;
          align-items: start;
          padding-top: 12px;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-image-wrap {
          width: 100%;
          aspect-ratio: 4 / 5;
          overflow: hidden;
          background: #f1eee8;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-image {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-info {
          min-width: 0;
          padding: 4px 24px 0 0;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-eyebrow {
          margin: 0 0 14px;
          font-size: 10px;
          line-height: 1;
          letter-spacing: .14em;
          text-transform: uppercase;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-title {
          margin: 0;
          font-size: 19px;
          line-height: 1.25;
          font-weight: 400;
          letter-spacing: -.02em;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-price {
          margin-top: 16px;
          font-size: 18px;
          line-height: 1.1;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-tax {
          margin-top: 6px;
          color: #999;
          font-size: 10px;
          line-height: 1.35;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-selection {
          margin-top: 22px;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-label {
          margin: 0 0 11px;
          font-size: 10px;
          line-height: 1;
          letter-spacing: .18em;
          text-transform: uppercase;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-sizes {
          display: grid;
          grid-template-columns:
            repeat(4, minmax(0, 1fr));
          gap: 6px;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-size,

        #on-repeat-mobile-quick-add
        .or-mqa-fit {
          min-height: 50px;
          box-sizing: border-box;
          border: 1px solid #c8c8c8;
          background: #fff;
          color: #222;
          font: inherit;
          font-size: 13px;
          letter-spacing: .04em;
          cursor: pointer;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-size.is-selected,

        #on-repeat-mobile-quick-add
        .or-mqa-fit.is-selected {
          border-color: #111;
          box-shadow:
            inset 0 0 0 1px #111;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-size:disabled {
          color: #b7b7b7;
          background: #f8f8f8;
          text-decoration: line-through;
          cursor: not-allowed;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-fit-wrap {
          margin-top: 6px;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-fit {
          width: 100%;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-submit {
          width: 100%;
          min-height: 58px;
          margin-top: 18px;
          padding: 0 14px;
          border: 1.5px solid #111;
          background: #111;
          color: #fff;
          font: inherit;
          font-size: 11px;
          letter-spacing: .2em;
          text-transform: uppercase;
          cursor: pointer;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-submit:disabled {
          opacity: .4;
          cursor: not-allowed;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-meta {
          margin-top: 12px;
          text-align: center;
          font-size: 10px;
          line-height: 1.45;
          color: #666;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-details {
          display: block;
          width: fit-content;
          margin: 18px auto 0;
          padding-bottom: 4px;
          border-bottom: 1px solid #111;
          color: #111;
          text-decoration: none;
          font-size: 10px;
          letter-spacing: .16em;
          text-transform: uppercase;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-error {
          display: none;
          margin-top: 10px;
          color: #9a2424;
          text-align: center;
          font-size: 11px;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-error.is-visible {
          display: block;
        }

        body.or-mqa-locked {
          overflow: hidden !important;
          touch-action: none;
        }
      }

      @media (max-width: 380px) {

        #on-repeat-mobile-quick-add
        .or-mqa-product {
          grid-template-columns:
            minmax(0, 39%)
            minmax(0, 1fr);
          gap: 14px;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-title {
          font-size: 17px;
        }

        #on-repeat-mobile-quick-add
        .or-mqa-price {
          font-size: 16px;
        }
      }
    `;

    document.head.appendChild(style);

    const root = document.createElement('div');

    root.id = 'on-repeat-mobile-quick-add';

    root.setAttribute('aria-hidden', 'true');

    root.innerHTML = `
      <div
        class="or-mqa-backdrop"
        data-mqa-close
      ></div>

      <div
        class="or-mqa-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Select product size and fit"
      >

        <button
          type="button"
          class="or-mqa-close"
          aria-label="Close"
          data-mqa-close
        ></button>

        <div class="or-mqa-product">

          <div class="or-mqa-image-wrap">
            <img
              class="or-mqa-image"
              src=""
              alt=""
            >
          </div>

          <div class="or-mqa-info">

            <div class="or-mqa-eyebrow">
              NEW
            </div>

            <h2 class="or-mqa-title"></h2>

            <div class="or-mqa-price"></div>

            <div class="or-mqa-tax">
              MRP incl. taxes for 1 unit
            </div>

          </div>

        </div>

        <div class="or-mqa-selection">

          <div class="or-mqa-label">
            SELECT SIZE &amp; FIT
          </div>

          <div class="or-mqa-sizes">

            ${SIZES.map(
              (size) => `
                <button
                  type="button"
                  class="or-mqa-size"
                  data-size="${size}"
                >
                  ${size}
                </button>
              `
            ).join('')}

          </div>

          <div class="or-mqa-fit-wrap">

            <button
              type="button"
              class="or-mqa-fit is-selected"
              data-fit="Regular"
            >
              Regular
            </button>

          </div>

          <button
            type="button"
            class="or-mqa-submit"
            disabled
          >
            SELECT SIZE &amp; FIT
          </button>

          <div class="or-mqa-meta">
            Free Shipping • 60-Day Returns &
            Exchanges • Ships in 24 Hours
          </div>

          <a
            href="#"
            class="or-mqa-details"
          >
            VIEW DETAILS &amp; OFFERS
          </a>

          <div class="or-mqa-error"></div>

        </div>

      </div>
    `;

    document.body.appendChild(root);

    return root;
  };

  const root = createSheet();

  const image =
    root.querySelector('.or-mqa-image');

  const title =
    root.querySelector('.or-mqa-title');

  const price =
    root.querySelector('.or-mqa-price');

  const details =
    root.querySelector('.or-mqa-details');

  const submit =
    root.querySelector('.or-mqa-submit');

  const errorBox =
    root.querySelector('.or-mqa-error');

  const sizeButtons = [
    ...root.querySelectorAll('.or-mqa-size')
  ];

  const fitButtons = [
    ...root.querySelectorAll('.or-mqa-fit')
  ];

  let product = null;
  let productUrl = '';
  let selectedSize = '';
  let selectedFit = 'Regular';
  let selectedVariant = null;

  const setError = (message = '') => {
    errorBox.textContent = message;

    errorBox.classList.toggle(
      'is-visible',
      Boolean(message)
    );
  };

  const findOptionIndex = (names) => {
    if (!product?.options) return -1;

    return product.options.findIndex(
      (option) =>
        names.includes(
          normalize(option.name)
        )
    );
  };

  const variantMatches = (
    variant,
    size,
    fit
  ) => {
    if (!variant?.available) return false;

    const sizeIndex = findOptionIndex([
      'size',
      'sizes'
    ]);

    const fitIndex = findOptionIndex([
      'fit',
      'fits'
    ]);

    const sizeMatches =
      sizeIndex === -1 ||
      normalize(
        variant.options[sizeIndex]
      ) === normalize(size);

    const fitMatches =
      fitIndex === -1 ||
      normalize(
        variant.options[fitIndex]
      ) === normalize(fit);

    return sizeMatches && fitMatches;
  };

  const findVariant = () => {
    if (!product || !selectedSize) {
      return null;
    }

    return (
      product.variants?.find(
        (variant) =>
          variantMatches(
            variant,
            selectedSize,
            selectedFit
          )
      ) || null
    );
  };

  const sizeIsAvailable = (size) => {
    if (!product?.variants) return false;

    return product.variants.some(
      (variant) =>
        variantMatches(
          variant,
          size,
          selectedFit
        )
    );
  };

  const refresh = () => {

    sizeButtons.forEach((button) => {

      const size =
        button.dataset.size || '';

      const available =
        sizeIsAvailable(size);

      button.disabled = !available;

      button.classList.toggle(
        'is-selected',
        normalize(size) ===
          normalize(selectedSize)
      );

    });

    fitButtons.forEach((button) => {

      button.classList.toggle(
        'is-selected',
        normalize(button.dataset.fit) ===
          normalize(selectedFit)
      );

    });

    selectedVariant = findVariant();

    submit.disabled = !selectedVariant;

    submit.textContent =
      selectedVariant
        ? 'ADD TO CART'
        : 'SELECT SIZE & FIT';

    if (
      selectedSize &&
      !selectedVariant
    ) {
      setError(
        'This size is currently unavailable.'
      );
    } else {
      setError('');
    }
  };

  const open = (
    quickAdd,
    data
  ) => {

    product = data;

    productUrl =
      getProductUrl(quickAdd);

    selectedSize = '';
    selectedFit = 'Regular';
    selectedVariant = null;

    image.src =
      product.featured_image ||
      product.images?.[0] ||
      '';

    image.alt =
      product.title || '';

    title.textContent =
      product.title ||
      quickAdd.dataset.productTitle ||
      '';

    price.textContent =
      formatMoney(product.price);

    details.href =
      productUrl || '#';

    submit.disabled = true;

    submit.textContent =
      'SELECT SIZE & FIT';

    setError('');

    root.classList.add('is-open');

    root.setAttribute(
      'aria-hidden',
      'false'
    );

    document.body.classList.add(
      'or-mqa-locked'
    );

    refresh();
  };

  const close = () => {

    root.classList.remove(
      'is-open'
    );

    root.setAttribute(
      'aria-hidden',
      'true'
    );

    document.body.classList.remove(
      'or-mqa-locked'
    );

    product = null;
    productUrl = '';
    selectedSize = '';
    selectedVariant = null;
  };

  const loadProduct = async (
    url
  ) => {

    const response =
      await fetch(
        `${url}.js`,
        {
          headers: {
            Accept:
              'application/json'
          },
          credentials:
            'same-origin',
        }
      );

    if (!response.ok) {
      throw new Error(
        'Product could not be loaded.'
      );
    }

    return response.json();
  };

  const dispatchCartUpdate = () => {

    const promise =
      Promise.resolve({
        detail: {
          didError: false
        }
      });

    const event =
      new CustomEvent(
        StandardEvents.cartLinesUpdate,
        {
          bubbles: true,
          detail: {
            promise
          },
        }
      );

    event.promise = promise;

    document.dispatchEvent(event);

    document.dispatchEvent(
      new CustomEvent(
        'cart:updated',
        {
          bubbles: true
        }
      )
    );
  };

  const openCartDrawer = () => {

    const drawer =
      document.querySelector(
        'cart-drawer-component, cart-drawer, [data-cart-drawer]'
      );

    if (!drawer) return;

    const openMethod =
      drawer.open ||
      drawer.showDialog ||
      drawer.openDrawer;

    if (
      typeof openMethod ===
      'function'
    ) {

      try {

        openMethod.call(drawer);

        return;

      } catch {
        // Fallback below.
      }
    }

    const cartButton =
      document.querySelector(
        'button[aria-label*="cart" i]:not([aria-label*="close" i]), a[href$="/cart"]'
      );

    cartButton?.click();
  };

  const addToCart = async () => {

    if (!selectedVariant) return;

    submit.disabled = true;

    submit.textContent =
      'ADDING...';

    setError('');

    try {

      const response =
        await fetch(
          '/cart/add.js',
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',

              Accept:
                'application/json',
            },

            credentials:
              'same-origin',

            body: JSON.stringify({
              items: [
                {
                  id:
                    selectedVariant.id,

                  quantity: 1
                }
              ]
            }),
          }
        );

      if (!response.ok) {

        const data =
          await response
            .json()
            .catch(() => ({}));

        throw new Error(
          data.description ||
          data.message ||
          'Unable to add this product.'
        );
      }

      close();

      dispatchCartUpdate();

      window.setTimeout(
        () => {
          openCartDrawer();
        },
        100
      );

    } catch (error) {

      submit.disabled = false;

      submit.textContent =
        'ADD TO CART';

      setError(
        error?.message ||
        'Unable to add this product.'
      );
    }
  };

  document.addEventListener(
    'click',
    async (event) => {

      if (!isMobile()) return;

      const target =
        event.target instanceof Element
          ? event.target
          : null;

      const chooseButton =
        target?.closest(
          '.quick-add__button--choose'
        );

      if (!chooseButton) return;

      const quickAdd =
        chooseButton.closest(
          'quick-add-component'
        );

      if (
        !quickAdd ||
        quickAdd.dataset
          .usesSellingPlans === 'true'
      ) {
        return;
      }

      const url =
        getProductUrl(quickAdd);

      if (!url) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      chooseButton.setAttribute(
        'aria-busy',
        'true'
      );

      try {

        const data =
          await loadProduct(url);

        open(
          quickAdd,
          data
        );

      } catch (error) {

        console.error(
          '[ON REPEAT Quick Add]',
          error
        );

      } finally {

        chooseButton.removeAttribute(
          'aria-busy'
        );
      }
    },
    true
  );

  sizeButtons.forEach(
    (button) => {

      button.addEventListener(
        'click',
        () => {

          if (button.disabled) return;

          selectedSize =
            button.dataset.size || '';

          refresh();
        }
      );

    }
  );

  fitButtons.forEach(
    (button) => {

      button.addEventListener(
        'click',
        () => {

          selectedFit =
            button.dataset.fit ||
            'Regular';

          refresh();
        }
      );

    }
  );

  root.addEventListener(
    'click',
    (event) => {

      const target =
        event.target instanceof Element
          ? event.target
          : null;

      if (
        target?.closest(
          '[data-mqa-close]'
        )
      ) {
        close();
        return;
      }

      if (
        target?.closest(
          '.or-mqa-submit'
        )
      ) {
        void addToCart();
      }
    }
  );

  document.addEventListener(
    'keydown',
    (event) => {

      if (
        event.key === 'Escape' &&
        root.classList.contains(
          'is-open'
        )
      ) {
        close();
      }

    }
  );

})();