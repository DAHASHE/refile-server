// share.js

class ShareManager {
  constructor(app) {
    this.app = app;
    this.isPanelOpen = false;
    this.panel = null;
    this.mode = 'home';
    this.ws = null;
    this.sessionCode = null;
    this.isHost = false;
    this.connectionState = 'disconnected';
    this.incomingFiles = new Map();
    this.transferHistory = [];
    this.pingInterval = null;
    this.licenseData = null;

    // ✅ عنوان السيرفر
    this.SERVER_URL = 'wss://your-server.railway.app';
    this.API_URL = 'https://your-server.railway.app';

    this._init();
  }

  async _init() {
    this._createPanel();
    await this._loadHistory();
    await this._loadLicense();
  }

  // ═══════════════════════════════════════════════════════
  // نظام الـ License
  // ═══════════════════════════════════════════════════════

  async _loadLicense() {
    try {
      const data = await chrome.storage.local.get(['refileLicense']);
      if (data.refileLicense) {
        this.licenseData = data.refileLicense;
      }
    } catch (e) {
      console.error('Load license error:', e);
    }
  }

  async _saveLicense(licenseData) {
    try {
      await chrome.storage.local.set({ refileLicense: licenseData });
      this.licenseData = licenseData;
    } catch (e) {
      console.error('Save license error:', e);
    }
  }

  _isLicenseValid() {
    if (!this.licenseData) return false;
    if (Date.now() > this.licenseData.expiresAt) return false;
    return this.licenseData.valid === true;
  }

  async _activateLicense(key) {
    try {
      const res = await fetch(`${this.API_URL}/api/verify-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: key })
      });

      const data = await res.json();

      if (data.valid) {
        await this._saveLicense({
          ...data,
          key: key,
          activatedAt: Date.now()
        });
        return { success: true, data };
      } else {
        return { success: false, error: data.error };
      }
    } catch (e) {
      return {
        success: false,
        error: this._t('تعذر الاتصال بالسيرفر', 'Cannot connect to server')
      };
    }
  }

  async _removeLicense() {
    await chrome.storage.local.remove(['refileLicense']);
    this.licenseData = null;
  }

  // ═══════════════════════════════════════════════════════
  // WebSocket
  // ═══════════════════════════════════════════════════════

  _connectWebSocket() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.SERVER_URL);

        this.ws.onopen = () => {
          // ── التحقق من الـ License فور الاتصال ────────────
          this._send({
            type: 'verify',
            licenseKey: this.licenseData.key
          });
        };

        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);

            if (msg.type === 'verify_result') {
              if (msg.valid) {
                this._startPing();
                resolve();
              } else {
                reject(new Error(msg.error));
                this.ws.close();
              }
              return;
            }

            this._handleServerMessage(msg);
          } catch (e) {
            console.error('Parse error:', e);
          }
        };

        this.ws.onclose = () => {
          this._stopPing();
          this.connectionState = 'disconnected';
          if (this.mode === 'active') {
            this._showToast('warning',
              this._t('انقطع الاتصال', 'Disconnected'), '');
            this.mode = 'home';
            this._render();
          }
        };

        this.ws.onerror = () => {
          reject(new Error(
            this._t('تعذر الاتصال بالسيرفر', 'Cannot connect to server')
          ));
        };

        setTimeout(() => reject(
          new Error('Connection timeout')
        ), 10000);

      } catch (e) {
        reject(e);
      }
    });
  }

  _send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  _startPing() {
    this.pingInterval = setInterval(() => {
      this._send({ type: 'ping' });
    }, 25000);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // رسائل السيرفر
  // ═══════════════════════════════════════════════════════

  _handleServerMessage(msg) {
    switch (msg.type) {
      case 'created':
        this.sessionCode = msg.code;
        this.connectionState = 'waiting';
        this._render();
        break;

      case 'guest_joined':
        this.connectionState = 'connected';
        this.mode = 'active';
        this._render();
        this._showToast('success',
          this._t('🎉 مستخدم انضم!', '🎉 User Joined!'), '');
        break;

      case 'joined':
        this.connectionState = 'connected';
        this.mode = 'active';
        this._render();
        this._showToast('success',
          this._t('✅ تم الاتصال!', '✅ Connected!'), '');
        break;

      case 'file':
        this.incomingFiles.set(msg.id, msg);
        this._render();
        this._showToast('info',
          this._t('📥 ملف وارد!', '📥 Incoming File!'), msg.path);
        break;

      case 'partner_left':
        this._showToast('warning',
          this._t('المستخدم الآخر غادر', 'Partner left'), '');
        this.connectionState = 'disconnected';
        this.mode = 'home';
        this._render();
        break;

      case 'error':
        this._showToast('error', this.app.t('notifError'), msg.error);
        break;
    }
  }

  // ═══════════════════════════════════════════════════════
  // الأفعال
  // ═══════════════════════════════════════════════════════

  async _generateCode() {
    if (!this._isLicenseValid()) {
      this.mode = 'license';
      this._render();
      return;
    }

    try {
      this.mode = 'loading';
      this._render();
      await this._connectWebSocket();
      this.isHost = true;
      this._send({ type: 'create' });
    } catch (e) {
      this.mode = 'home';
      this._render();
      this._showToast('error', this.app.t('notifError'), e.message);
    }
  }

  async _doConnect() {
    if (!this._isLicenseValid()) {
      this.mode = 'license';
      this._render();
      return;
    }

    const input = this.panel.querySelector('.fsp-connect-input');
    const code = input?.value.trim()
      .replace(/[^A-Z0-9]/gi, '').toUpperCase();

    if (!code || code.length < 10) {
      this._showToast('warning',
        this._t('كود غير صحيح', 'Invalid Code'), '');
      return;
    }

    try {
      this.mode = 'loading';
      this._render();
      await this._connectWebSocket();
      this.isHost = false;
      this._send({ type: 'join', sessionId: code });
    } catch (e) {
      this.mode = 'connect';
      this._render();
      this._showToast('error', this.app.t('notifError'), e.message);
    }
  }

  async _doActivateLicense() {
    const input = this.panel.querySelector('.fsp-license-input');
    const key = input?.value.trim().toUpperCase();

    if (!key || key.length < 10) {
      this._showToast('warning',
        this._t('مفتاح غير صحيح', 'Invalid key'), '');
      return;
    }

    const btn = this.panel.querySelector('[data-share-action="activate-license"]');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `
        <div class="fsp-spinner-mini"></div>
        <span>${this._t('جاري التحقق...', 'Verifying...')}</span>`;
    }

    const result = await this._activateLicense(key);

    if (result.success) {
      this._showToast('success',
        this._t('✅ تم التفعيل!', '✅ Activated!'),
        result.data.email);
      this.mode = 'home';
      this._render();
    } else {
      this._showToast('error',
        this._t('فشل التفعيل', 'Activation Failed'),
        result.error);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          ${this.app.c95().check()}
          ${this._t('تفعيل', 'Activate')}`;
      }
    }
  }

  async _selectFilesToSend() {
    const files = [...this.app.a10];
    if (!files.length) {
      this._showToast('warning',
        this._t('لا توجد ملفات محددة', 'No files selected'),
        this._t('حدد ملفات من الشجرة أولاً', 'Select files from tree'));
      return;
    }
    for (const path of files) await this._sendFile(path);
  }

  async _sendFile(path) {
    try {
      const info = this.app.a15.get(path);
      if (!info?.handle) return;

      const file = await info.handle.getFile();
      const maxSize = this.licenseData?.maxFileSize || 5 * 1024 * 1024;

      if (file.size > maxSize) {
        this._showToast('error',
          this._t('الملف كبير جداً', 'File too large'),
          `Max: ${maxSize / 1024 / 1024}MB`);
        return;
      }

      const content = await file.text();
      this._send({
        type: 'file',
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        path,
        content,
        size: content.length,
        timestamp: Date.now()
      });

      this.transferHistory.unshift({
        path, size: content.length,
        direction: 'sent', status: 'success',
        timestamp: Date.now()
      });
      this._saveHistory();

      this._showToast('success',
        this._t('✅ تم الإرسال!', '✅ Sent!'), path);

    } catch (e) {
      this._showToast('error', this.app.t('notifError'), e.message);
    }
  }

  async _acceptFile(fileId) {
    const fileData = this.incomingFiles.get(fileId);
    if (!fileData || !this.app.a13?.handle) return;

    try {
      const parts = fileData.path.split('/');
      let dir = this.app.a13.handle;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: true });
      }
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(fileData.content);
      await w.close();

      this.incomingFiles.delete(fileId);
      this.transferHistory.unshift({
        ...fileData,
        direction: 'received',
        status: 'accepted'
      });
      this._saveHistory();

      await this.app.c50();
      this.app.c72();

      this._showToast('success',
        this._t('✅ تم الحفظ!', '✅ Saved!'), fileData.path);
      this._render();

    } catch (e) {
      this._showToast('error', this.app.t('notifError'), e.message);
    }
  }

  _rejectFile(fileId) {
    this.incomingFiles.delete(fileId);
    this._render();
  }

  _disconnect() {
    this._stopPing();
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.sessionCode = null;
    this.isHost = false;
    this.connectionState = 'disconnected';
    this.mode = 'home';
    this._render();
  }

  // ═══════════════════════════════════════════════════════
  // السجل
  // ═══════════════════════════════════════════════════════

  async _loadHistory() {
    try {
      const data = await this.app.c17('settings', 'shareHistory');
      if (data?.items) this.transferHistory = data.items;
    } catch (e) {}
  }

  async _saveHistory() {
    try {
      await this.app.c19('settings', {
        key: 'shareHistory',
        items: this.transferHistory.slice(0, 100),
        timestamp: Date.now()
      });
    } catch (e) {}
  }

  async _clearHistory() {
    this.transferHistory = [];
    await this._saveHistory();
    this._render();
    this._showToast('success',
      this._t('تم المسح!', 'Cleared!'), '');
  }

  // ═══════════════════════════════════════════════════════
  // الواجهة
  // ═══════════════════════════════════════════════════════

  toggle() {
    this.isPanelOpen ? this.closePanel() : this.openPanel();
  }

  openPanel() {
    if (this.isPanelOpen) return;
    this.isPanelOpen = true;
    this.panel.classList.add('active');
    this._updatePosition();
    this._render();
  }

  closePanel() {
    if (!this.isPanelOpen) return;
    this.isPanelOpen = false;
    this.panel.classList.remove('active');
  }

  _updatePosition() {
    if (!this.panel || !this.app.a5) return;
    const r = this.app.a5.getBoundingClientRect();
    const gap = 10;
    let left = r.left - r.width - gap;
    if (left < 8) left = r.right + gap;
    left = Math.max(8, Math.min(window.innerWidth - r.width - 8, left));
    const top = Math.max(8, Math.min(window.innerHeight - r.height - 8, r.top));
    this.panel.style.cssText =
      `width:${r.width}px;height:${r.height}px;top:${top}px;left:${left}px;`;
  }

  _createPanel() {
    const el = document.createElement('div');
    el.className = 'fsp-share-panel';
    el.setAttribute('lang', this.app.currentLang);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-share-action]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      this._handleAction(btn.dataset.shareAction, btn);
    });
    document.body.appendChild(el);
    this.panel = el;
  }

  async _handleAction(action, btn) {
    switch (action) {
      case 'close':         this.closePanel(); break;
      case 'back':          this.mode = 'home'; this._render(); break;
      case 'generate':      await this._generateCode(); break;
      case 'connect':       this.mode = 'connect'; this._render(); break;
      case 'do-connect':    await this._doConnect(); break;
      case 'copy-code':     await this._copyCode(); break;
      case 'disconnect':    this._disconnect(); break;
      case 'send-files':    await this._selectFilesToSend(); break;
      case 'accept-file':   await this._acceptFile(btn.dataset.id); break;
      case 'reject-file':   this._rejectFile(btn.dataset.id); break;
      case 'show-history':  this.mode = 'history'; this._render(); break;
      case 'clear-history': await this._clearHistory(); break;
      case 'show-license':  this.mode = 'license'; this._render(); break;
      case 'activate-license': await this._doActivateLicense(); break;
      case 'remove-license':
        await this._removeLicense();
        this.mode = 'home';
        this._render();
        break;
    }
  }

  async _copyCode() {
    if (!this.sessionCode) return;
    try {
      await navigator.clipboard.writeText(this.sessionCode);
      this._showToast('success',
        this._t('تم النسخ!', 'Copied!'), this.sessionCode);
    } catch (e) {
      this._showToast('error', this.app.t('notifError'), e.message);
    }
  }

  _render() {
    if (!this.panel) return;
    const map = {
      home:    () => this._renderHome(),
      loading: () => this._renderLoading(),
      generate:() => this._renderGenerate(),
      connect: () => this._renderConnect(),
      active:  () => this._renderActive(),
      history: () => this._renderHistory(),
      license: () => this._renderLicense()
    };
    this.panel.innerHTML = (map[this.mode] || map.home)();
  }

  _t(ar, en) {
    return this.app.currentLang === 'ar' ? ar : en;
  }

  _icons() { return this.app.c95(); }

  // ── صفحة اللايسنس ──────────────────────────────────────
  _renderLicense() {
    const valid = this._isLicenseValid();
    const d = this.licenseData;

    return `
      <div class="fsp-sh-wrap">
        ${this._renderHeader(this._t('الاشتراك المميز', 'Pro License'))}
        <div class="fsp-sh-body">

          ${valid ? `
            <div class="fsp-sh-license-active">
              <div class="fsp-sh-license-icon">✅</div>
              <div class="fsp-sh-license-info">
                <div class="fsp-sh-license-title">
                  ${this._t('اشتراك نشط', 'Active Subscription')}
                </div>
                <div class="fsp-sh-license-email">${d.email}</div>
                <div class="fsp-sh-license-expiry">
                  ${this._t('ينتهي في', 'Expires')}:
                  ${new Date(d.expiresAt).toLocaleDateString(
                    this.app.currentLang === 'ar' ? 'ar-SA' : 'en-US'
                  )}
                </div>
                <div class="fsp-sh-license-plan">
                  ⭐ ${d.plan?.toUpperCase() || 'PRO'}
                </div>
              </div>
            </div>
            <button class="fsp-sh-btn-danger-outline"
              data-share-action="remove-license">
              ${this._t('إلغاء الاشتراك', 'Remove License')}
            </button>
          ` : `
            <div class="fsp-sh-upgrade-hero">
              <div class="fsp-sh-upgrade-icon">⭐</div>
              <h2>${this._t('ReFile Pro', 'ReFile Pro')}</h2>
              <div class="fsp-sh-price">
                <span class="fsp-sh-price-amount">$3</span>
                <span class="fsp-sh-price-period">
                  /${this._t('شهر', 'month')}
                </span>
              </div>
            </div>

            <div class="fsp-sh-features-list">
              <div class="fsp-sh-feature-item">
                ${this._icons().check()}
                ${this._t(
                  'مشاركة الملفات مع أي مستخدم',
                  'Share files with any user'
                )}
              </div>
              <div class="fsp-sh-feature-item">
                ${this._icons().check()}
                ${this._t('نقل حتى 50MB', 'Transfer up to 50MB')}
              </div>
              <div class="fsp-sh-feature-item">
                ${this._icons().check()}
                ${this._t('جلسات غير محدودة', 'Unlimited sessions')}
              </div>
              <div class="fsp-sh-feature-item">
                ${this._icons().check()}
                ${this._t('دعم أولوية', 'Priority support')}
              </div>
            </div>

            <a href="https://your-site.com/buy"
              target="_blank"
              class="fsp-sh-btn-upgrade">
              ${this._t('اشترك الآن', 'Subscribe Now')} →
            </a>

            <div class="fsp-sh-divider">
              ${this._t('لديك مفتاح تفعيل؟', 'Have a license key?')}
            </div>

            <div class="fsp-sh-activate-form">
              <input type="text"
                class="fsp-license-input"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                dir="ltr"
                maxlength="24"
                autocomplete="off"
                style="text-transform:uppercase">
              <button class="fsp-sh-btn-primary"
                data-share-action="activate-license">
                ${this._icons().check()}
                ${this._t('تفعيل', 'Activate')}
              </button>
            </div>
          `}
        </div>
      </div>`;
  }

  // ── الصفحات الأخرى (مختصرة) ────────────────────────────

  _renderHome() {
    const valid = this._isLicenseValid();
    return `
      <div class="fsp-sh-wrap">
        <div class="fsp-sh-header">
          <div class="fsp-sh-header-left">
            <div class="fsp-sh-logo">
              <svg viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="5" r="3"/>
                <circle cx="5" cy="19" r="3"/>
                <circle cx="19" cy="19" r="3"/>
                <path d="M12 8v3M7 17l3-3M17 17l-3-3"
                  stroke-linecap="round"/>
              </svg>
            </div>
            <span class="fsp-sh-header-title">
              ${this._t('مشاركة المشروع', 'Share Project')}
            </span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${valid
              ? `<div class="fsp-sh-pro-badge">⭐ PRO</div>`
              : `<button class="fsp-sh-btn-upgrade-sm"
                   data-share-action="show-license">
                   ${this._t('ترقية', 'Upgrade')}
                 </button>`}
            <button class="fsp-sh-btn-icon" data-share-action="close">
              ${this._icons().x()}
            </button>
          </div>
        </div>

        <div class="fsp-sh-body">
          ${!valid ? `
            <div class="fsp-sh-upgrade-banner">
              <span>⭐</span>
              <div>
                <strong>${this._t('ميزة Pro', 'Pro Feature')}</strong>
                <p>
                  ${this._t(
                    'اشترك للمشاركة مع مستخدمين آخرين',
                    'Subscribe to share with other users'
                  )}
                </p>
              </div>
              <button class="fsp-sh-btn-upgrade-sm"
                data-share-action="show-license">
                ${this._t('$3/شهر', '$3/mo')}
              </button>
            </div>
          ` : ''}

          <div class="fsp-sh-cards">
            <button class="fsp-sh-card fsp-sh-card-green
              ${!valid ? 'fsp-sh-card-locked' : ''}"
              data-share-action="generate">
              <div class="fsp-sh-card-icon">
                <svg viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2"/>
                  <path d="M7 11V7a5 5 0 0110 0v4" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="fsp-sh-card-text">
                <div class="fsp-sh-card-title">
                  ${this._t('إنشاء كود مشاركة', 'Generate Share Code')}
                </div>
                <div class="fsp-sh-card-desc">
                  ${valid
                    ? this._t('استقبل الملفات', 'Receive files')
                    : '🔒 ' + this._t('يتطلب اشتراك Pro', 'Requires Pro')}
                </div>
              </div>
              <div class="fsp-sh-card-arrow">→</div>
            </button>

            <button class="fsp-sh-card fsp-sh-card-blue
              ${!valid ? 'fsp-sh-card-locked' : ''}"
              data-share-action="connect">
              <div class="fsp-sh-card-icon">
                <svg viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"
                    stroke-linecap="round"/>
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"
                    stroke-linecap="round"/>
                </svg>
              </div>
              <div class="fsp-sh-card-text">
                <div class="fsp-sh-card-title">
                  ${this._t('أدخل كود المشاركة', 'Enter Share Code')}
                </div>
                <div class="fsp-sh-card-desc">
                  ${valid
                    ? this._t('أرسل الملفات', 'Send files')
                    : '🔒 ' + this._t('يتطلب اشتراك Pro', 'Requires Pro')}
                </div>
              </div>
              <div class="fsp-sh-card-arrow">→</div>
            </button>

            <button class="fsp-sh-card fsp-sh-card-amber"
              data-share-action="show-history">
              <div class="fsp-sh-card-icon">${this._icons().clock()}</div>
              <div class="fsp-sh-card-text">
                <div class="fsp-sh-card-title">
                  ${this._t('سجل النقل', 'Transfer History')}
                </div>
                <div class="fsp-sh-card-desc">
                  ${this.transferHistory.length}
                  ${this._t(' عملية', ' transfers')}
                </div>
              </div>
              <div class="fsp-sh-card-arrow">→</div>
            </button>
          </div>
        </div>
      </div>`;
  }

  _renderLoading() {
    return `
      <div class="fsp-sh-wrap">
        ${this._renderHeader(this._t('جاري الاتصال...', 'Connecting...'))}
        <div class="fsp-sh-body fsp-sh-center">
          <div class="fsp-sh-loading">
            <div class="fsp-sh-spinner">
              <svg viewBox="0 0 50 50">
                <circle cx="25" cy="25" r="20" fill="none"
                  stroke="#6366f1" stroke-width="4"
                  stroke-linecap="round" stroke-dasharray="80 40"/>
              </svg>
            </div>
            <p>${this._t('جاري الاتصال...', 'Connecting...')}</p>
          </div>
        </div>
      </div>`;
  }

  _renderGenerate() {
    return `
      <div class="fsp-sh-wrap">
        ${this._renderHeader(this._t('كود المشاركة', 'Share Code'))}
        <div class="fsp-sh-body">
          ${this.sessionCode ? `
            <p class="fsp-sh-label">
              ${this._t('شارك هذا الكود:', 'Share this code:')}
            </p>
            <div class="fsp-sh-code-box">
              <div class="fsp-sh-code-value" dir="ltr">
                ${this.sessionCode}
              </div>
              <button class="fsp-sh-copy-btn"
                data-share-action="copy-code">
                ${this._icons().copy()}
              </button>
            </div>
            <div class="fsp-sh-waiting">
              <div class="fsp-sh-pulse"></div>
              <span>${this._t(
                'في انتظار الطرف الآخر...',
                'Waiting for other user...'
              )}</span>
            </div>
          ` : `
            <div class="fsp-sh-center">
              <div class="fsp-sh-loading">
                <div class="fsp-sh-spinner">
                  <svg viewBox="0 0 50 50">
                    <circle cx="25" cy="25" r="20" fill="none"
                      stroke="#6366f1" stroke-width="4"
                      stroke-linecap="round" stroke-dasharray="80 40"/>
                  </svg>
                </div>
              </div>
            </div>
          `}
        </div>
      </div>`;
  }

  _renderConnect() {
    return `
      <div class="fsp-sh-wrap">
        ${this._renderHeader(this._t('الاتصال', 'Connect'))}
        <div class="fsp-sh-body">
          <div class="fsp-sh-connect-form">
            <label class="fsp-sh-label">
              ${this._t('أدخل كود المشاركة:', 'Enter Share Code:')}
            </label>
            <input type="text" class="fsp-connect-input"
              placeholder="ABCD-EFGH-IJKL"
              dir="ltr" maxlength="20"
              autocomplete="off"
              style="text-transform:uppercase">
            <button class="fsp-sh-btn-primary"
              data-share-action="do-connect">
              ${this._icons().check()}
              ${this._t('اتصال', 'Connect')}
            </button>
          </div>
        </div>
      </div>`;
  }

  _renderActive() {
    const inc = [...this.incomingFiles.values()];
    return `
      <div class="fsp-sh-wrap">
        ${this._renderHeader(this._t('جلسة نشطة', 'Active Session'))}
        <div class="fsp-sh-body">
          <div class="fsp-sh-session-bar">
            <div class="fsp-sh-connected-badge">
              <div class="fsp-sh-dot-green"></div>
              ${this._t('متصل', 'Connected')}
            </div>
            <button class="fsp-sh-btn-danger-sm"
              data-share-action="disconnect">
              ${this._icons().x()}
              ${this._t('قطع', 'End')}
            </button>
          </div>
          <button class="fsp-sh-send-btn"
            data-share-action="send-files">
            <svg viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4
                M17 8l-5-5-5 5M12 3v12"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div>
              <div class="fsp-sh-send-title">
                ${this._t('إرسال الملفات المحددة', 'Send Selected Files')}
              </div>
              <div class="fsp-sh-send-hint">
                ${this.app.a10.size > 0
                  ? `${this.app.a10.size} ${this._t('ملف', 'files')}`
                  : this._t('حدد ملفات أولاً', 'Select files first')}
              </div>
            </div>
          </button>
          ${inc.length > 0 ? `
            <div class="fsp-sh-incoming">
              <div class="fsp-sh-incoming-title">
                <span>${this._t('ملفات واردة', 'Incoming')}</span>
                <span class="fsp-sh-badge-count">${inc.length}</span>
              </div>
              <div class="fsp-sh-file-list">
                ${inc.map(f => `
                  <div class="fsp-sh-file-item">
                    <div class="fsp-sh-file-icon">
                      ${this.app.c100(f.path)}
                    </div>
                    <div class="fsp-sh-file-info">
                      <div class="fsp-sh-file-path" dir="ltr">
                        ${this.app.c99(f.path)}
                      </div>
                      <div class="fsp-sh-file-meta">
                        ${this.app.c98(f.size)}
                        • ${this.app.c101(f.timestamp)}
                      </div>
                    </div>
                    <div class="fsp-sh-file-btns">
                      <button class="fsp-sh-accept-btn"
                        data-share-action="accept-file"
                        data-id="${f.id}">
                        ${this._icons().check()}
                      </button>
                      <button class="fsp-sh-reject-btn"
                        data-share-action="reject-file"
                        data-id="${f.id}">
                        ${this._icons().x()}
                      </button>
                    </div>
                  </div>`).join('')}
              </div>
            </div>
          ` : `
            <div class="fsp-sh-empty-sm">
              ${this._icons().inbox()}
              <p>${this._t('لا توجد ملفات واردة', 'No incoming files')}</p>
            </div>
          `}
        </div>
      </div>`;
  }

  _renderHistory() {
    const h = this.transferHistory.slice(0, 50);
    return `
      <div class="fsp-sh-wrap">
        ${this._renderHeader(this._t('سجل النقل', 'History'))}
        <div class="fsp-sh-body">
          ${h.length > 0 ? `
            <div class="fsp-sh-history-bar">
              <span>${h.length} ${this._t('عملية', 'transfers')}</span>
              <button class="fsp-sh-btn-sm-danger"
                data-share-action="clear-history">
                ${this._icons().trash()}
                ${this._t('مسح', 'Clear')}
              </button>
            </div>
            <div class="fsp-sh-history-list">
              ${h.map(item => `
                <div class="fsp-sh-history-item">
                  <div style="color:${item.direction === 'sent' ? '#10b981' : '#3b82f6'}">
                    <svg viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" stroke-width="2" width="18" height="18">
                      ${item.direction === 'sent'
                        ? '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke-linecap="round"/>'
                        : '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke-linecap="round"/>'}
                    </svg>
                  </div>
                  <div class="fsp-sh-h-info">
                    <div class="fsp-sh-h-path" dir="ltr">
                      ${this.app.c99(item.path)}
                    </div>
                    <div class="fsp-sh-h-meta">
                      ${this.app.c98(item.size || 0)}
                      • ${this.app.c101(item.timestamp)}
                    </div>
                  </div>
                  <div style="color:${['success','accepted'].includes(item.status) ? '#10b981' : '#ef4444'}">
                    ${['success','accepted'].includes(item.status)
                      ? this._icons().check_circle()
                      : this._icons().x_circle()}
                  </div>
                </div>`).join('')}
            </div>
          ` : `
            <div class="fsp-sh-empty">
              ${this._icons().clock()}
              <p>${this._t('لا يوجد سجل', 'No history')}</p>
            </div>
          `}
        </div>
      </div>`;
  }

  _renderHeader(title) {
    return `
      <div class="fsp-sh-header">
        <div class="fsp-sh-header-left">
          <button class="fsp-sh-btn-icon" data-share-action="back">
            <svg viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M19 12H5M12 19l-7-7 7-7"
                stroke-linecap="round"/>
            </svg>
          </button>
          <span class="fsp-sh-header-title">${title}</span>
        </div>
        <button class="fsp-sh-btn-icon" data-share-action="close">
          ${this._icons().x()}
        </button>
      </div>`;
  }

  _showToast(type, title, message) {
    this.app.c90(type, title, message);
  }

  destroy() {
    this._disconnect();
    if (this.panel) this.panel.remove();
  }
}

window.ShareManager = ShareManager;
