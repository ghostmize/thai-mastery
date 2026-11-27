/**
 * Firebase Multi-User Cloud Accounts & Sync Engine (Strict Invite-Only Gatekeeper)
 * Built for Thai & Hebrew Mastery Engines
 * 
 * Strict Lock:
 * - App is locked behind a strict login screen.
 * - Only users pre-created by the admin in Firebase Authentication can enter.
 * - Public self-registration is strictly blocked.
 * - Logged-in session is persisted in browser IndexedDB/LocalStorage forever.
 * - Each user gets their own isolated cloud database: /users/{userId}/progress/{appName}
 */

(function () {
  const IS_LOGGED_IN_KEY = 'mastery_is_authenticated_v1';
  const USERNAME_KEY = 'mastery_auth_username_v1';

  window.MASTER_FIREBASE_CONFIG = window.MASTER_FIREBASE_CONFIG || {
    apiKey: "AIzaSyDOJyD7e38ij7DY65zoQgqXy46Nml8Dokg",
    authDomain: "ilearn-c1baa.firebaseapp.com",
    projectId: "ilearn-c1baa",
    storageBucket: "ilearn-c1baa.firebasestorage.app",
    messagingSenderId: "811301098462",
    appId: "1:811301098462:web:8cc42f6857dc4eb99a034f",
    measurementId: "G-YFXF5CCWV4"
  };

  class MasteryAuthSync {
    constructor() {
      this.appName = window.location.pathname.includes('hebrew') ? 'hebrew' : 'thai';
      this.languageTitle = this.appName === 'hebrew' ? 'Hebrew' : 'Thai';
      this.appTitle = `iLearn • ${this.languageTitle}`;
      this.auth = null;
      this.db = null;
      this.currentUser = null;
      this.isInitialized = false;
      this.isPushing = false;
      this.pushTimer = null;
      this.unsubscribeSnapshot = null;
      this.lastSyncError = null;
      this.lastSyncedAt = null;
    }

    // Dynamic loader for Firebase SDK
    async loadFirebaseSDK() {
      if (window.firebase && window.firebase.auth && window.firebase.firestore) return;

      const scripts = [
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'
      ];

      for (const src of scripts) {
        if (!document.querySelector(`script[src="${src}"]`)) {
          await new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => resolve();
            document.head.appendChild(s);
          });
        }
      }
    }

    async init() {
      this.mountGatekeeperUI();
      // Re-assert cloud modal handler after inline page scripts parse
      window.openCloudSyncModal = () => {
        if (this.currentUser) this.openUserModal();
        else this.lockApp();
      };
      await this.loadFirebaseSDK();

      try {
        if (!window.firebase.apps.length) {
          window.firebase.initializeApp(window.MASTER_FIREBASE_CONFIG);
        }
        this.auth = window.firebase.auth();
        this.db = window.firebase.firestore();

        try {
          await this.db.enablePersistence({ synchronizeTabs: true });
        } catch (e) {}

        // Remember login permanently on this device
        await this.auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);

        this.auth.onAuthStateChanged(async (user) => {
          this.currentUser = user;
          if (user) {
            this.unlockApp(user);
            await this.listenToUserCloudData(user.uid);
          } else {
            this.lockApp();
            if (this.unsubscribeSnapshot) {
              this.unsubscribeSnapshot();
              this.unsubscribeSnapshot = null;
            }
          }
        });

        this.isInitialized = true;
      } catch (err) {
        console.error('[Auth Gatekeeper] Init Error:', err);
      }
    }

    // Lock Screen Gatekeeper Management
    mountGatekeeperUI() {
      const wasLoggedIn = localStorage.getItem(IS_LOGGED_IN_KEY) === 'true';
      const initialOverlayClass = wasLoggedIn ? 'hidden opacity-0 pointer-events-none' : 'flex opacity-100';

      if (wasLoggedIn) {
        const cachedName = localStorage.getItem(USERNAME_KEY) || 'Learner';
        this.updateNavbar({ displayName: cachedName });
      }

      // 1. Gatekeeper Fullscreen Overlay
      const gatekeeperHtml = `
      <div id="mastery-gatekeeper-overlay" class="fixed inset-0 z-[99999] bg-[#08090d]/95 backdrop-blur-xl ${initialOverlayClass} items-center justify-center p-4 transition-opacity duration-300">
        <div class="bg-[#12141c] border border-[#232735] rounded-3xl max-w-sm w-full p-7 space-y-5 shadow-2xl relative text-slate-200">
          
          <div class="text-center space-y-2">
            <div class="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-tr from-sky-500/20 to-indigo-500/20 border border-sky-400/30 flex items-center justify-center text-2xl shadow-inner">
              🔒
            </div>
            <h2 class="text-lg font-bold text-white tracking-wide">${this.appTitle}</h2>
            <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px] font-semibold">
              <span>🛡️</span>
              <span>Private • Invite Only</span>
            </div>
          </div>

          <form onsubmit="event.preventDefault(); window.masteryAuth.handleGatekeeperLogin();" class="space-y-3.5 pt-2">
            <div>
              <label class="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Username</label>
              <input id="gatekeeper-input-user" type="text" placeholder="e.g. alex" required autocomplete="username" autofocus class="w-full px-4 py-3 rounded-xl bg-[#090a0e] border border-[#222634] text-white text-sm focus:outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400 transition" />
            </div>

            <div>
              <label class="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">PIN / Password</label>
              <input id="gatekeeper-input-pin" type="password" placeholder="e.g. 123456" required autocomplete="current-password" class="w-full px-4 py-3 rounded-xl bg-[#090a0e] border border-[#222634] text-white text-sm focus:outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400 transition" />
            </div>

            <div id="gatekeeper-error" class="hidden text-xs text-rose-300 bg-rose-500/15 border border-rose-500/30 p-3 rounded-xl leading-relaxed"></div>

            <button type="submit" id="gatekeeper-submit-btn" class="w-full py-3 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white text-xs font-bold uppercase tracking-wider shadow-lg shadow-sky-500/20 transition cursor-pointer">
              Unlock &amp; Start Learning
            </button>
          </form>

          <p class="text-[11px] text-slate-400 text-center leading-relaxed">
            ✨ Once unlocked, this device will stay remembered so you never have to enter your PIN again.
          </p>

        </div>
      </div>
      `;

      // 2. Profile Management Modal (when logged in and clicking profile button)
      const userModalHtml = `
      <div id="mastery-user-modal" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-md hidden items-center justify-center p-4">
        <div class="bg-[#12141c] border border-[#232735] rounded-3xl max-w-sm w-full max-h-[90vh] overflow-y-auto p-6 space-y-4 shadow-2xl relative text-slate-200">
          <div class="flex items-center justify-between border-b border-[#20232f] pb-3">
            <h3 class="text-sm font-bold text-white tracking-wide">Learner Account</h3>
            <button onclick="window.masteryAuth.closeUserModal()" class="w-7 h-7 rounded-lg bg-[#1a1d27] hover:bg-[#252937] text-slate-400 hover:text-white text-xs flex items-center justify-center cursor-pointer transition">✕</button>
          </div>

          <div class="bg-gradient-to-r from-sky-500/10 to-indigo-500/10 border border-sky-500/20 rounded-2xl p-4 flex items-center gap-3">
            <div id="user-modal-avatar" class="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 text-white font-bold text-base flex items-center justify-center shrink-0">U</div>
            <div class="truncate">
              <div id="user-modal-name" class="text-sm font-bold text-white truncate">Learner</div>
              <div id="user-modal-email" class="text-[11px] text-slate-400 truncate"></div>
              <div id="user-modal-status" class="text-[11px] text-emerald-400 flex items-center gap-1 mt-0.5">
                <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>Active Cloud Sync</span>
              </div>
            </div>
          </div>

          <div id="user-modal-sync-detail" class="text-[11px] text-slate-400 bg-[#090a0e] border border-[#222634] rounded-xl px-3 py-2 hidden"></div>

          <div id="offline-section" class="bg-[#0e0f12] border border-[#252934] rounded-2xl p-3.5 text-xs space-y-2.5">
            <div class="flex items-center justify-between gap-2">
              <div class="font-semibold text-amber-300">📥 Offline Mode</div>
              <span id="offline-status-text" class="text-slate-400 text-[11px] text-right">Checking...</span>
            </div>
            <p class="text-slate-400 text-[11px] leading-snug">Save the app and all lessons on this device so it works with no internet (planes, subway, no data). Audio uses your phone's built-in voice when offline.</p>
            <div id="offline-progress-wrap" class="hidden h-1.5 rounded-full bg-[#1e2128] overflow-hidden">
              <div id="offline-progress-bar" class="h-full bg-amber-400 transition-all" style="width:0%"></div>
            </div>
            <div class="flex gap-2">
              <button id="offline-download-btn" onclick="downloadOffline()" class="flex-1 px-3 py-2 rounded-xl bg-amber-400/20 hover:bg-amber-400/30 border border-amber-400/40 text-amber-200 font-semibold cursor-pointer">Download for offline</button>
              <button id="offline-remove-btn" onclick="removeOffline()" class="hidden px-3 py-2 rounded-xl bg-[#1e2128] hover:bg-[#282c37] border border-[#323744] text-slate-300 cursor-pointer">Remove</button>
            </div>
          </div>

          <div class="pt-1 flex gap-2">
            <button onclick="window.masteryAuth.forceSyncNow()" class="flex-1 py-2 px-3 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/30 text-sky-300 text-xs font-semibold cursor-pointer transition">
              🔄 Sync Now
            </button>
            <button onclick="window.masteryAuth.logout()" class="py-2 px-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold cursor-pointer transition">
              🚪 Log Out
            </button>
          </div>
        </div>
      </div>
      `;

      document.body.insertAdjacentHTML('beforeend', gatekeeperHtml);
      document.body.insertAdjacentHTML('beforeend', userModalHtml);
    }

    lockApp() {
      localStorage.removeItem(IS_LOGGED_IN_KEY);
      localStorage.removeItem(USERNAME_KEY);
      const overlay = document.getElementById('mastery-gatekeeper-overlay');
      if (overlay) {
        overlay.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
        overlay.classList.add('flex', 'opacity-100');
      }
      this.updateNavbar(null);
    }

    unlockApp(user) {
      localStorage.setItem(IS_LOGGED_IN_KEY, 'true');
      const name = this.getUserDisplayName();
      if (name) localStorage.setItem(USERNAME_KEY, name);

      const overlay = document.getElementById('mastery-gatekeeper-overlay');
      if (overlay) {
        overlay.classList.add('opacity-0', 'pointer-events-none');
        overlay.classList.add('hidden');
        overlay.classList.remove('flex');
      }
      this.updateNavbar(user);
    }

    getUserDisplayName() {
      if (this.currentUser && this.currentUser.email) {
        const email = this.currentUser.email;
        const raw = email.split('@')[0];
        return raw.charAt(0).toUpperCase() + raw.slice(1);
      }
      return localStorage.getItem(USERNAME_KEY) || 'Learner';
    }

    updateNavbar(user) {
      const btn = document.getElementById('cloud-sync-btn');
      if (!btn) return;

      if (user) {
        const name = this.getUserDisplayName();
        btn.innerHTML = `
          <span class="w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400"></span>
          <span class="w-4 h-4 rounded-full bg-sky-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
            ${name.charAt(0).toUpperCase()}
          </span>
          <span class="text-xs font-semibold text-slate-200 hidden sm:inline max-w-[80px] truncate">${name}</span>
        `;
        btn.onclick = () => this.openUserModal();
        btn.title = `Logged in as ${name} (Click to manage account)`;
      } else {
        btn.innerHTML = `
          <span class="w-2 h-2 rounded-full bg-rose-500"></span>
          <span class="text-xs">🔒</span>
          <span class="text-xs font-semibold text-slate-300 hidden sm:inline">Locked</span>
        `;
        btn.onclick = () => this.lockApp();
        btn.title = 'Invite-only login required';
      }
    }

    async handleGatekeeperLogin() {
      const userInput = document.getElementById('gatekeeper-input-user');
      const pinInput = document.getElementById('gatekeeper-input-pin');
      const errBox = document.getElementById('gatekeeper-error');
      const submitBtn = document.getElementById('gatekeeper-submit-btn');

      errBox.classList.add('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying...';

      const raw = userInput.value.trim().toLowerCase();
      const email = raw.includes('@') ? raw : `${raw}@mastery.app`;
      const pin = pinInput.value.trim();

      try {
        // STRICT: Only signs in existing users pre-approved by admin in Firebase.
        // Self-registration is completely removed!
        await this.auth.signInWithEmailAndPassword(email, pin);
        this.notifyToast(`Welcome back, ${raw}! 🚀`);
      } catch (err) {
        console.warn('[Gatekeeper Error]', err.code);
        errBox.innerHTML = `⛔ <strong>Access Denied:</strong> Invalid Username or PIN.<br><span class="text-[11px] text-slate-400">This app is invite-only. Please contact the owner if you need access.</span>`;
        errBox.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Unlock & Start Learning';
      }
    }

    async logout() {
      if (!this.auth) return;
      localStorage.removeItem(IS_LOGGED_IN_KEY);
      localStorage.removeItem(USERNAME_KEY);
      if (this.unsubscribeSnapshot) {
        this.unsubscribeSnapshot();
        this.unsubscribeSnapshot = null;
      }
      this.closeUserModal();
      await this.auth.signOut();
      this.lockApp();
      this.notifyToast('Logged out');
    }

    openUserModal() {
      if (!this.currentUser) return;
      const m = document.getElementById('mastery-user-modal');
      if (!m) return;
      const name = this.getUserDisplayName();
      document.getElementById('user-modal-name').textContent = name;
      document.getElementById('user-modal-avatar').textContent = name.charAt(0).toUpperCase();
      const emailEl = document.getElementById('user-modal-email');
      if (emailEl) emailEl.textContent = `${this.currentUser.email || ''} • ${this.appName}`;
      this.updateModalSyncStatus();
      if (typeof window.renderOfflineStatus === 'function') window.renderOfflineStatus();
      m.classList.remove('hidden');
      m.classList.add('flex');
    }

    updateModalSyncStatus() {
      const statusEl = document.getElementById('user-modal-status');
      const detailEl = document.getElementById('user-modal-sync-detail');
      if (statusEl) {
        if (this.lastSyncError) {
          statusEl.className = 'text-[11px] text-rose-400 flex items-center gap-1 mt-0.5';
          statusEl.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-400"></span><span>Sync Error</span>`;
        } else {
          statusEl.className = 'text-[11px] text-emerald-400 flex items-center gap-1 mt-0.5';
          statusEl.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>Active Cloud Sync</span>`;
        }
      }
      if (detailEl) {
        if (this.lastSyncError) {
          detailEl.textContent = `Error: ${this.lastSyncError}`;
          detailEl.classList.remove('hidden');
        } else if (this.lastSyncedAt) {
          detailEl.textContent = `Last synced: ${new Date(this.lastSyncedAt).toLocaleTimeString()}`;
          detailEl.classList.remove('hidden');
        } else {
          detailEl.classList.add('hidden');
        }
      }
    }

    closeUserModal() {
      const m = document.getElementById('mastery-user-modal');
      if (m) {
        m.classList.add('hidden');
        m.classList.remove('flex');
      }
    }

    applyRemoteData(remoteData, showToastOnMerge = true) {
      if (!remoteData || !window.appState || typeof window.mergeCloudState !== 'function') return false;
      const hasChanges = window.mergeCloudState(window.appState, remoteData);
      if (hasChanges) {
        if (typeof window.saveState === 'function') window.saveState(true);
        if (typeof window.updateTrackUI === 'function') window.updateTrackUI();
        if (typeof window.renderSkillTree === 'function') window.renderSkillTree();
        if (typeof window.renderBank === 'function') window.renderBank();
        if (typeof window.updateTopMetricsUI === 'function') window.updateTopMetricsUI();
        if (showToastOnMerge) {
          this.notifyToast(`☁️ Cloud progress synced (${this.getUserDisplayName()})`);
        }
      }
      return hasChanges;
    }

    localHasAheadProgress(remoteData) {
      if (!window.appState || !remoteData) return false;
      const local = window.appState;
      if ((local.xp || 0) > (remoteData.xp || 0)) return true;
      const remoteNodes = Array.isArray(remoteData.completedNodes) ? remoteData.completedNodes : [];
      if ((local.completedNodes || []).some(n => !remoteNodes.includes(n))) return true;
      const remoteStats = remoteData.itemStats || {};
      const localStats = local.itemStats || {};
      for (const id of Object.keys(localStats)) {
        const ls = localStats[id];
        const rs = remoteStats[id];
        if ((ls.exposures || 0) > (rs?.exposures || 0)) return true;
      }
      return false;
    }

    // Real-Time Firestore Sync per user
    async listenToUserCloudData(uid) {
      if (!this.db) return;
      if (this.unsubscribeSnapshot) this.unsubscribeSnapshot();

      const docRef = this.db.collection('users').doc(uid).collection('progress').doc(this.appName);

      this.unsubscribeSnapshot = docRef.onSnapshot((docSnap) => {
        if (this.isPushing) return;
        this.lastSyncError = null;
        this.lastSyncedAt = Date.now();
        this.updateModalSyncStatus();

        if (docSnap.exists) {
          const remoteData = docSnap.data();
          this.applyRemoteData(remoteData, true);
          if (this.localHasAheadProgress(remoteData)) {
            this.pushToCloud(true);
          }
        } else {
          // First time this user logs in: upload local progress to their cloud database
          this.pushToCloud(true);
        }
      }, (err) => {
        console.warn('[Sync Error]', err);
        this.lastSyncError = err.message || String(err);
        this.updateModalSyncStatus();
      });
    }

    async pullFromServer(showToastOnMerge = true) {
      if (!this.isInitialized || !this.currentUser || !this.db) return false;
      try {
        const docRef = this.db.collection('users').doc(this.currentUser.uid).collection('progress').doc(this.appName);
        const docSnap = await docRef.get({ source: 'server' });
        this.lastSyncError = null;
        this.lastSyncedAt = Date.now();
        this.updateModalSyncStatus();
        if (docSnap.exists) {
          const remoteData = docSnap.data();
          this.applyRemoteData(remoteData, showToastOnMerge);
          if (this.localHasAheadProgress(remoteData)) {
            await this.pushToCloud(true);
          }
        }
        return true;
      } catch (err) {
        console.warn('[Sync Pull Error]', err);
        this.lastSyncError = err.message || String(err);
        this.updateModalSyncStatus();
        return false;
      }
    }

    schedulePush() {
      if (!this.isInitialized || !this.currentUser || !this.db) return;
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => {
        this.pushToCloud(false);
      }, 1500);
    }

    async pushToCloud(immediate = false) {
      if (!this.isInitialized || !this.currentUser || !this.db || !window.appState) return false;

      this.isPushing = true;
      try {
        const docRef = this.db.collection('users').doc(this.currentUser.uid).collection('progress').doc(this.appName);
        const payload = JSON.parse(JSON.stringify(window.appState));
        payload.updatedAt = Date.now();
        payload.username = this.getUserDisplayName();

        await docRef.set(payload, { merge: true });
        this.lastSyncError = null;
        this.lastSyncedAt = Date.now();
        this.updateModalSyncStatus();
        return true;
      } catch (err) {
        console.error('[Sync Push Error]', err);
        this.lastSyncError = err.message || String(err);
        this.updateModalSyncStatus();
        return false;
      } finally {
        this.isPushing = false;
      }
    }

    async forceSyncNow() {
      if (!this.currentUser) {
        this.notifyToast('Please sign in first to sync');
        return;
      }
      await this.pullFromServer(false);
      const ok = await this.pushToCloud(true);
      if (ok) {
        this.notifyToast('☁️ Progress synced with cloud!');
      } else {
        this.notifyToast(`⚠️ Sync failed: ${this.lastSyncError || 'Check connection'}`);
      }
    }

    notifyToast(msg) {
      if (typeof window.showToast === 'function') {
        window.showToast(msg);
      }
    }
  }

  window.masteryAuth = new MasteryAuthSync();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.masteryAuth.init());
  } else {
    window.masteryAuth.init();
  }

  // Hook into saveState and re-pull when tab/PWA becomes visible
  window.addEventListener('load', () => {
    if (typeof window.saveState === 'function') {
      const orig = window.saveState;
      window.saveState = function (skipCloudPush = false) {
        orig(skipCloudPush);
        if (!skipCloudPush && window.masteryAuth) {
          window.masteryAuth.schedulePush();
        }
      };
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.masteryAuth && window.masteryAuth.currentUser) {
      window.masteryAuth.pullFromServer(true);
    }
  });

  window.openCloudSyncModal = function () {
    if (window.masteryAuth) {
      if (window.masteryAuth.currentUser) {
        window.masteryAuth.openUserModal();
      } else {
        window.masteryAuth.lockApp();
      }
    }
  };
})();
