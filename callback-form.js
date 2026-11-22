(function () {
  'use strict';

  const META_PIXEL_ID = '1025014860112458';
  const CLINIC_PHONE_HREF = '+35799373304';
  const CLINIC_PHONE_DISPLAY = '+357 99 373304';
  const VALID_CYPRUS_FIRST_DIGITS = new Set(['2', '7', '8', '9']);

  const pageLoadedAt = Date.now();
  let turnstileSiteKey = '';
  let turnstileScriptPromise = null;

  // ---------- Helpers ----------

  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function getAttributionData() {
    const params = new URLSearchParams(window.location.search);
    const utm = {
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      utm_content: params.get('utm_content') || '',
      utm_term: params.get('utm_term') || ''
    };

    const fbp = getCookie('_fbp');
    let fbc = getCookie('_fbc');
    const fbclid = params.get('fbclid');
    if (!fbc && fbclid) {
      fbc = 'fb.1.' + Math.floor(Date.now() / 1000) + '.' + fbclid;
    }

    return { utm, fbp, fbc };
  }

  function splitFullName(raw) {
    const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
    const firstSpace = cleaned.indexOf(' ');
    if (firstSpace === -1) {
      return { fullName: cleaned, firstName: cleaned, lastName: '' };
    }
    return {
      fullName: cleaned,
      firstName: cleaned.slice(0, firstSpace),
      lastName: cleaned.slice(firstSpace + 1).trim()
    };
  }

  function validateName(raw) {
    const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
    if (cleaned.length < 2) {
      return { valid: false, message: 'Please enter your full name.' };
    }
    if (cleaned.length > 120) {
      return { valid: false, message: 'Please enter a shorter name.' };
    }
    // Support Latin, Greek, and other Unicode letters
    const letters = cleaned.match(/[A-Za-z\u00C0-\u024F\u0370-\u03FF\u1F00-\u1FFF]/g) || [];
    if (letters.length < 2) {
      return { valid: false, message: 'Please enter a valid name.' };
    }
    if (/https?:\/\/|www\./i.test(cleaned)) {
      return { valid: false, message: 'Please enter your name without web links.' };
    }
    const lowerLetters = letters.join('').toLowerCase();
    if (lowerLetters.length >= 4 && /^(.)\1+$/.test(lowerLetters)) {
      return { valid: false, message: 'Please enter your real name.' };
    }
    return { valid: true, cleaned };
  }

  function isObviousJunkDigits(local8) {
    if (/^(\d)\1{7}$/.test(local8)) return true; // 99999999, 11111111
    if (/(\d)\1{5,}/.test(local8)) return true; // 99111111, 99000000
    const sequential = [
      '12345678',
      '87654321',
      '01234567',
      '76543210',
      '23456789',
      '98765432'
    ];
    if (sequential.includes(local8)) return true;
    if (/(123456|234567|345678|654321|765432|876543)$/.test(local8)) return true;
    if (/^(\d{2})\1{3}$/.test(local8)) return true;
    return false;
  }

  function extractCyprusLocal8(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 8) return digits;
    if (digits.startsWith('357') && digits.length === 11) return digits.slice(3);
    if (digits.startsWith('00357') && digits.length === 13) return digits.slice(5);
    return null;
  }

  function validateCyprusPhone(rawValue, itiInstance) {
    const trimmed = String(rawValue || '').trim();
    if (!trimmed) {
      return { valid: false, message: 'Please enter your Cyprus phone number.' };
    }

    let candidateNumber = trimmed;
    let itiValid = null;

    if (itiInstance) {
      try {
        const fullNum = itiInstance.getNumber();
        if (fullNum) candidateNumber = fullNum;
        if (typeof itiInstance.isValidNumber === 'function') {
          itiValid = itiInstance.isValidNumber();
        }
      } catch (e) {
        itiValid = null;
      }
    }

    const local8 = extractCyprusLocal8(candidateNumber) || extractCyprusLocal8(trimmed);
    if (!local8) {
      return {
        valid: false,
        message: 'Please enter an 8-digit Cyprus phone number (e.g. 99 123456).'
      };
    }

    if (!VALID_CYPRUS_FIRST_DIGITS.has(local8[0])) {
      return {
        valid: false,
        message: 'Please enter a valid Cyprus mobile or landline number.'
      };
    }

    if (isObviousJunkDigits(local8)) {
      return {
        valid: false,
        message: 'That phone number looks invalid. Please double-check it.'
      };
    }

    // Use libphonenumber validation when loaded, without over-rejecting valid local prefixes
    if (itiValid === false) {
      return {
        valid: false,
        message: 'Please enter a valid Cyprus phone number (e.g. 99 123456).'
      };
    }

    return {
      valid: true,
      e164: '+357' + local8,
      digitsWithCountry: '357' + local8,
      formatted: '+357 ' + local8.slice(0, 2) + ' ' + local8.slice(2)
    };
  }

  // ---------- Cloudflare Turnstile Loader ----------

  async function loadPublicConfig() {
    try {
      const res = await fetch('/api/config', { method: 'GET', credentials: 'same-origin' });
      if (!res.ok) return;
      const cfg = await res.json();
      if (cfg && typeof cfg.turnstileSiteKey === 'string') {
        turnstileSiteKey = cfg.turnstileSiteKey.trim();
      }
    } catch {
      // Static local preview without /api/config — continue gracefully
    }
  }

  function ensureTurnstileScript() {
    if (!turnstileSiteKey) return Promise.resolve(false);
    if (window.turnstile) return Promise.resolve(true);
    if (turnstileScriptPromise) return turnstileScriptPromise;

    turnstileScriptPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(Boolean(window.turnstile));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });

    return turnstileScriptPromise;
  }

  // ---------- Meta Pixel Lead Event (Advanced Matching + Deduplication) ----------

  function fireMetaLeadEvent(result, fullNameRaw, formLocation) {
    if (typeof window.fbq !== 'function') return;
    if (!result || result.trackLead === false || !result.eventId) return;

    try {
      const nameParts = splitFullName(fullNameRaw);
      const userData = {
        fn: (result.firstName || nameParts.firstName || '').trim().toLowerCase(),
        ph: String(result.phoneDigits || '').replace(/\D/g, ''),
        country: 'cy'
      };
      const ln = (result.lastName || nameParts.lastName || '').trim().toLowerCase();
      if (ln) {
        userData.ln = ln;
      }

      // Pass normalized Advanced Matching fields to Meta Pixel before firing Lead
      window.fbq('init', META_PIXEL_ID, userData);
      window.fbq(
        'track',
        'Lead',
        {
          content_name: 'Callback Request',
          lead_type: 'phone_callback',
          form_location: formLocation || 'hero'
        },
        {
          eventID: result.eventId
        }
      );
    } catch (err) {
      console.warn('Meta Pixel Lead tracking error:', err);
    }
  }

  // ---------- Field Error UI ----------

  function setFieldError(groupEl, inputEl, errorEl, message) {
    if (!groupEl || !errorEl) return;
    if (message) {
      groupEl.classList.add('has-error');
      if (inputEl) inputEl.setAttribute('aria-invalid', 'true');
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      groupEl.classList.remove('has-error');
      if (inputEl) inputEl.setAttribute('aria-invalid', 'false');
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
  }

  // ---------- Initialize Each Callback Form ----------

  function initCallbackForm(form, turnstileReadyPromise) {
    const formLocation = form.getAttribute('data-form-location') || 'hero';
    const cardEl = form.closest('.callback-form-card');
    const nameInput = form.querySelector('input[name="fullName"]');
    const phoneInput = form.querySelector('input[name="phone"]');
    const honeypotInput = form.querySelector('input[name="website"]');
    const submitBtn = form.querySelector('button[type="submit"]');
    const submitLabel = submitBtn ? submitBtn.querySelector('.btn-label') : null;
    const nameGroup = nameInput ? nameInput.closest('.form-field') : null;
    const phoneGroup = phoneInput ? phoneInput.closest('.form-field') : null;
    const nameError = nameGroup ? nameGroup.querySelector('.field-error') : null;
    const phoneError = phoneGroup ? phoneGroup.querySelector('.field-error') : null;
    const formErrorBanner = form.querySelector('.form-error-banner');
    const turnstileSlot = form.querySelector('.cf-turnstile-slot');
    const successPanel = cardEl ? cardEl.querySelector('.callback-success') : null;

    if (!nameInput || !phoneInput || !submitBtn) return;

    const state = {
      isSubmitting: false,
      nameTyped: false,
      phoneTyped: false,
      turnstileWidgetId: null,
      turnstileToken: '',
      turnstileWaiters: []
    };

    // Initialize intl-tel-input immediately for Cyprus (+357)
    let iti = null;
    if (typeof window.intlTelInput === 'function') {
      try {
        iti = window.intlTelInput(phoneInput, {
          initialCountry: 'cy',
          onlyCountries: ['cy'],
          allowDropdown: false,
          separateDialCode: true,
          formatAsYouType: true,
          autoPlaceholder: 'aggressive',
          countrySearch: false
        });
      } catch (err) {
        console.warn('intl-tel-input initialization failed, using fallback validation:', err);
      }
    }

    // Mount Cloudflare Turnstile asynchronously once config + script finish loading
    const turnstileMountedPromise = turnstileReadyPromise.then(function (ready) {
      if (!ready || !turnstileSiteKey || !window.turnstile || !turnstileSlot) {
        return false;
      }
      try {
        state.turnstileWidgetId = window.turnstile.render(turnstileSlot, {
          sitekey: turnstileSiteKey,
          theme: 'light',
          appearance: 'interaction-only',
          callback: function (token) {
            state.turnstileToken = token || '';
            while (state.turnstileWaiters.length) {
              const resolve = state.turnstileWaiters.shift();
              resolve(state.turnstileToken);
            }
          },
          'expired-callback': function () {
            state.turnstileToken = '';
          },
          'error-callback': function () {
            state.turnstileToken = '';
            while (state.turnstileWaiters.length) {
              const resolve = state.turnstileWaiters.shift();
              resolve('');
            }
          }
        });
        return true;
      } catch (err) {
        console.warn('Turnstile render error:', err);
        return false;
      }
    });

    async function waitForTurnstileToken(timeoutMs) {
      await turnstileMountedPromise;
      if (!turnstileSiteKey || state.turnstileWidgetId === null || !window.turnstile) {
        return '';
      }
      if (state.turnstileToken) {
        return state.turnstileToken;
      }
      try {
        const existing = window.turnstile.getResponse(state.turnstileWidgetId);
        if (existing) {
          state.turnstileToken = existing;
          return existing;
        }
      } catch {
        // ignore
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(state.turnstileToken || ''), timeoutMs);
        state.turnstileWaiters.push((token) => {
          clearTimeout(timer);
          resolve(token || '');
        });
      });
    }

    // Validate on blur ONLY (never show new errors on every keystroke; never clear user's input)
    nameInput.addEventListener('blur', function () {
      if (!nameInput.value.trim() && !state.nameTyped && !(nameGroup && nameGroup.classList.contains('has-error'))) {
        return;
      }
      const res = validateName(nameInput.value);
      setFieldError(nameGroup, nameInput, nameError, res.valid ? '' : res.message);
    });

    phoneInput.addEventListener('blur', function () {
      if (!phoneInput.value.trim() && !state.phoneTyped && !(phoneGroup && phoneGroup.classList.contains('has-error'))) {
        return;
      }
      const res = validateCyprusPhone(phoneInput.value, iti);
      setFieldError(phoneGroup, phoneInput, phoneError, res.valid ? '' : res.message);
    });

    // Track typing and quietly clear an already-visible error once fixed
    nameInput.addEventListener('input', function () {
      if (nameInput.value.length > 0) state.nameTyped = true;
      if (nameGroup && nameGroup.classList.contains('has-error')) {
        if (validateName(nameInput.value).valid) {
          setFieldError(nameGroup, nameInput, nameError, '');
        }
      }
    });

    phoneInput.addEventListener('input', function () {
      if (phoneInput.value.length > 0) state.phoneTyped = true;
      if (phoneGroup && phoneGroup.classList.contains('has-error')) {
        if (validateCyprusPhone(phoneInput.value, iti).valid) {
          setFieldError(phoneGroup, phoneInput, phoneError, '');
        }
      }
    });

    function showSubmissionError(customText) {
      if (!formErrorBanner) return;
      const msgEl = formErrorBanner.querySelector('.form-error-text');
      if (msgEl && customText) {
        msgEl.textContent = customText;
      }
      formErrorBanner.hidden = false;
    }

    function hideSubmissionError() {
      if (formErrorBanner) {
        formErrorBanner.hidden = true;
      }
    }

    function setLoading(loading) {
      state.isSubmitting = loading;
      submitBtn.disabled = loading;
      submitBtn.classList.toggle('is-loading', loading);
      submitBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (submitLabel) {
        if (!submitBtn.dataset.originalLabel) {
          submitBtn.dataset.originalLabel = submitLabel.textContent;
        }
        submitLabel.textContent = loading ? 'Sending request...' : submitBtn.dataset.originalLabel;
      }
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (state.isSubmitting) return;

      hideSubmissionError();

      const nameCheck = validateName(nameInput.value);
      const phoneCheck = validateCyprusPhone(phoneInput.value, iti);

      setFieldError(nameGroup, nameInput, nameError, nameCheck.valid ? '' : nameCheck.message);
      setFieldError(phoneGroup, phoneInput, phoneError, phoneCheck.valid ? '' : phoneCheck.message);

      if (!nameCheck.valid) {
        nameInput.focus();
        return;
      }
      if (!phoneCheck.valid) {
        phoneInput.focus();
        return;
      }

      // Lock submit button immediately to prevent double-submits
      setLoading(true);

      try {
        const token = await waitForTurnstileToken(4000);
        const attribution = getAttributionData();

        const payload = {
          fullName: nameCheck.cleaned,
          phone: phoneCheck.e164,
          website: honeypotInput ? honeypotInput.value : '',
          elapsedMs: Date.now() - pageLoadedAt,
          turnstileToken: token,
          formLocation: formLocation,
          pageUrl: window.location.href,
          utm: attribution.utm,
          fbp: attribution.fbp,
          fbc: attribution.fbc
        };

        const response = await fetch('/api/lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.ok) {
          if (data && data.field === 'fullName') {
            setFieldError(nameGroup, nameInput, nameError, data.error || 'Please enter your full name.');
            nameInput.focus();
            setLoading(false);
            return;
          }
          if (data && data.field === 'phone') {
            setFieldError(phoneGroup, phoneInput, phoneError, data.error || 'Please enter a valid Cyprus phone number.');
            phoneInput.focus();
            setLoading(false);
            return;
          }

          if (state.turnstileWidgetId !== null && window.turnstile) {
            state.turnstileToken = '';
            try {
              window.turnstile.reset(state.turnstileWidgetId);
            } catch {
              // ignore
            }
          }

          showSubmissionError(
            (data && data.code === 'TURNSTILE_FAILED')
              ? 'Please complete the quick security check below and tap again — or call us directly.'
              : 'We couldn’t send your request right now.'
          );
          setLoading(false);
          return;
        }

        // Verified success: fire Meta Pixel Lead with eventID deduplication (skipped if honeypot trap returned trackLead:false)
        fireMetaLeadEvent(data, nameCheck.cleaned, formLocation);

        // Show clear confirmation state
        if (successPanel) {
          const confirmName = successPanel.querySelector('[data-confirm-name]');
          const confirmPhone = successPanel.querySelector('[data-confirm-phone]');
          if (confirmName) confirmName.textContent = splitFullName(nameCheck.cleaned).firstName;
          if (confirmPhone) confirmPhone.textContent = data.phoneFormatted || phoneCheck.formatted;
          form.hidden = true;
          successPanel.hidden = false;
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.error('Callback submission error:', err);
        if (state.turnstileWidgetId !== null && window.turnstile) {
          state.turnstileToken = '';
          try {
            window.turnstile.reset(state.turnstileWidgetId);
          } catch {
            // ignore
          }
        }
        showSubmissionError('Connection issue — we couldn’t submit your request.');
        setLoading(false);
      }
    });
  }

  // ---------- Sticky Button Scroll-to-Form & Visibility ----------

  function initScrollAndStickyControls() {
    const scrollTriggers = document.querySelectorAll('[data-scroll-to-form]');
    scrollTriggers.forEach((btn) => {
      btn.addEventListener('click', function (e) {
        const targetId = btn.getAttribute('data-scroll-to-form') || 'callback-form-hero';
        const targetEl = document.getElementById(targetId) || document.querySelector('.callback-form');
        if (!targetEl) return;

        e.preventDefault();
        const card = targetEl.closest('.callback-form-card') || targetEl;
        const header = document.querySelector('.header');
        const headerOffset = header ? header.offsetHeight + 16 : 84;
        const rect = card.getBoundingClientRect();
        const scrollTop = window.pageYOffset + rect.top - headerOffset;

        window.scrollTo({
          top: Math.max(0, scrollTop),
          behavior: 'smooth'
        });

        const firstInput = targetEl.querySelector('input[name="fullName"]');
        if (firstInput && !targetEl.hidden) {
          setTimeout(() => {
            try {
              firstInput.focus({ preventScroll: true });
            } catch {
              firstInput.focus();
            }
          }, 420);
        }
      });
    });

    // Hide mobile sticky bar while any callback form is already visible on screen
    const stickyBar = document.querySelector('.mobile-sticky-cta');
    const formCards = document.querySelectorAll('.callback-form-card');
    if (stickyBar && formCards.length && 'IntersectionObserver' in window) {
      const visibleCards = new Set();
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              visibleCards.add(entry.target);
            } else {
              visibleCards.delete(entry.target);
            }
          });
          stickyBar.classList.toggle('is-hidden', visibleCards.size > 0);
        },
        { threshold: 0.25 }
      );
      formCards.forEach((card) => observer.observe(card));
    }
  }

  // ---------- Desktop Phone Modal (for Footer/Contact direct tel: links, ZERO Meta Lead/Contact events) ----------

  function initAuxiliaryLinks() {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const modal = document.getElementById('phone-modal');
    const modalOverlay = document.getElementById('phone-modal-overlay');
    const modalCloseBtn = document.getElementById('phone-modal-close');
    const modalDoneBtn = document.getElementById('phone-modal-close-btn');
    const modalCopyBtn = document.getElementById('phone-modal-copy-btn');
    const modalCopyText = document.getElementById('phone-modal-copy-text');

    function openPhoneModal() {
      if (!modal) return;
      modal.classList.add('is-active');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    }

    function closePhoneModal() {
      if (!modal) return;
      modal.classList.remove('is-active');
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    }

    if (modalOverlay) modalOverlay.addEventListener('click', closePhoneModal);
    if (modalCloseBtn) modalCloseBtn.addEventListener('click', closePhoneModal);
    if (modalDoneBtn) modalDoneBtn.addEventListener('click', closePhoneModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.classList.contains('is-active')) {
        closePhoneModal();
      }
    });

    if (modalCopyBtn && modalCopyText) {
      modalCopyBtn.addEventListener('click', () => {
        navigator.clipboard
          .writeText(CLINIC_PHONE_DISPLAY)
          .then(() => {
            const originalText = modalCopyText.textContent;
            modalCopyText.textContent = 'Copied!';
            modalCopyBtn.classList.add('copied');
            setTimeout(() => {
              modalCopyText.textContent = originalText;
              modalCopyBtn.classList.remove('copied');
            }, 2000);
          })
          .catch(() => {});
      });
    }

    // Notice: we intentionally do NOT fire any Meta Pixel events on tel: clicks (especially fallback call links)
    const phoneLinks = document.querySelectorAll('a[href^="tel:"]');
    phoneLinks.forEach((link) => {
      link.addEventListener('click', (e) => {
        if (!isMobile && modal) {
          e.preventDefault();
          openPhoneModal();
        }
      });
    });

    const mainSiteLinks = document.querySelectorAll('.main-site-link');
    mainSiteLinks.forEach((link) => {
      link.addEventListener('click', () => {
        try {
          if (typeof window.fbq === 'function') {
            window.fbq('trackCustom', 'ViewMainSite', {
              destination: 'main_website'
            });
          }
        } catch {
          // ignore
        }
      });
    });
  }

  // ---------- Bootstrap ----------

  function init() {
    initScrollAndStickyControls();
    initAuxiliaryLinks();

    const turnstileReadyPromise = loadPublicConfig().then(() => ensureTurnstileScript());
    const forms = document.querySelectorAll('.callback-form');
    forms.forEach((form) => initCallbackForm(form, turnstileReadyPromise));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
