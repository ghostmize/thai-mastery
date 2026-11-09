/**
 * Firebase Multi-User Cloud Accounts & Sync Engine
 * Built for Thai & Hebrew Mastery Engines
 * 
 * Features:
 * - Isolated Cloud Database per user in Google Cloud Firestore: /users/{userId}/progress/{appName}
 * - Auto-login / Permanent Session: Persisted in browser localStorage/IndexedDB forever
 * - Quick Sign In / Registration: Simple Username/Email + PIN/Password
 * - Real-time sync across desktop, mobile, tablet
 * - Zero-conflict friend isolation: Friends get their own blank start & progress
 */

(function () {
  const FIREBASE_CONFIG_STORAGE_KEY = 'mastery_firebase_config_v1';

  // You can paste your Firebase project config here, OR paste it in the in-app modal.
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
      this.auth = null;
      this.db = null;
      this.currentUser = null;
      this.isConfigured = false;
      this.isInitialized = false;
      this.isPushing = false;
      this.pushTimer = null;
      this.unsubscribeSnapshot = null;
    }

    // Dynamic loader for Firebase SDK if not already in document
    async loadFirebaseSDK() {
      if (window.firebase && window.firebase.auth && window.firebase.firestore) return;

      const scripts = [
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'
      ];

      for (const src of scripts) {
        if (!document.querySelector(`script[src="${src}"]`)) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => {
              console.warn(`Could not load ${src}`);
              resolve(); // proceed gracefully
            };
            document.head.appendChild(s);
          });
        }
      }
    }

    getConfig() {
      try {
        const stored = localStorage.getItem(FIREBASE_CONFIG_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && parsed.apiKey && parsed.projectId) return parsed;
        }
      } catch (e) {}

      if (window.MASTER_FIREBASE_CONFIG && window.MASTER_FIREBASE_CONFIG.apiKey) {
        return window.MASTER_FIREBASE_CONFIG;
      }
      return null;
    }

    saveConfig(cfg) {
      if (!cfg || !cfg.apiKey || !cfg.projectId) {
        throw new Error('Please enter a valid Firebase config containing at least apiKey and projectId.');
      }
      localStorage.setItem(FIREBASE_CONFIG_STORAGE_KEY, JSON.stringify(cfg));
      window.location.reload();
    }

    async init() {
      this.mountModalUI();
      await this.loadFirebaseSDK();

      const config = this.getConfig();
      if (!config) {
        this.isConfigured = false;
        this.updateHeaderUI(null, 'unconfigured');
        return;
      }

      this.isConfigured = true;

      try {
        if (!window.firebase.apps.length) {
          window.firebase.initializeApp(config);
        }
        this.auth = window.firebase.auth();
        this.db = window.firebase.firestore();

        // Enable offline persistence in Firestore
        try {
          await this.db.enablePersistence({ synchronizeTabs: true });
        } catch (e) {
          // Persistence might fail if multiple tabs open or unsupported, ignorable
        }

        // Set auth to permanent local persistence (remembers login across browser closes / restarts)
        await this.auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);

        // Listen for user login/logout
        this.auth.onAuthStateChanged(async (user) => {
          this.currentUser = user;
          if (user) {
            this.updateHeaderUI(user, 'synced');
            this.updateModalLoggedInUI(user);
            await this.listenToUserCloudData(user.uid);
          } else {
            this.updateHeaderUI(null, 'logged_out');
            this.updateModalLoggedOutUI();
            if (this.unsubscribeSnapshot) {
              this.unsubscribeSnapshot();
              this.unsubscribeSnapshot = null;
            }
          }
        });

        this.isInitialized = true;
      } catch (err) {
        console.error('[Firebase Engine] Init Error:', err);
        this.updateHeaderUI(null, 'error');
      }
    }

    // Attach real-time snapshot listener to this specific user's document
    async listenToUserCloudData(uid) {
      if (!this.db) return;
      if (this.unsubscribeSnapshot) this.unsubscribeSnapshot();

      const userDocRef = this.db.collection('users').doc(uid).collection('progress').doc(this.appName);

      this.unsubscribeSnapshot = userDocRef.onSnapshot((docSnap) => {
        if (this.isPushing) return; // Ignore echoes of our own push

        if (docSnap.exists) {
          const remoteData = docSnap.data();
          if (remoteData && window.appState && typeof window.mergeCloudState === 'function') {
            const hasChanges = window.mergeCloudState(window.appState, remoteData);
            if (hasChanges) {
              if (typeof window.saveState === 'function') window.saveState(true);
              if (typeof window.updateTrackUI === 'function') window.updateTrackUI();
              if (typeof window.renderSkillTree === 'function') window.renderSkillTree();
              if (typeof window.renderBank === 'function') window.renderBank();
              if (typeof window.updateTopMetricsUI === 'function') window.updateTopMetricsUI();
              this.notifyToast(`☁️ Progress synced (${this.getUserDisplayName()})`);
            }
          }
        } else {
          // If the cloud document does not exist yet (brand new account), push local progress up!
          this.pushToCloud(true);
        }
      }, (err) => {
        console.warn('[Firebase Engine] Snapshot error:', err);
        this.updateIndicator('error', 'Cloud sync paused (Offline)');
      });
    }

    schedulePush() {
      if (!this.isInitialized || !this.currentUser || !this.db) return;
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => {
        this.pushToCloud(false);
      }, 1500);
    }

    async pushToCloud(immediate = false) {
      if (!this.isInitialized || !this.currentUser || !this.db || !window.appState) return;

      this.isPushing = true;
      this.updateIndicator('syncing', 'Saving to your cloud database...');

      try {
        const userDocRef = this.db.collection('users').doc(this.currentUser.uid).collection('progress').doc(this.appName);
        
        // Prepare clean serializable state
        const payload = JSON.parse(JSON.stringify(window.appState));
        payload.updatedAt = Date.now();
        payload.userEmail = this.currentUser.email || '';
        payload.userDisplayName = this.currentUser.displayName || '';

        await userDocRef.set(payload, { merge: true });
        this.updateIndicator('synced', `🟢 Synced with cloud (${this.getUserDisplayName()})`);
      } catch (err) {
        console.error('[Firebase Engine] Push Error:', err);
        this.updateIndicator('error', 'Failed to save to cloud');
      } finally {
        this.isPushing = false;
      }
    }

    getUserDisplayName() {
      if (!this.currentUser) return 'Guest';
      if (this.currentUser.displayName) return this.currentUser.displayName;
      if (this.currentUser.email) {
        return this.currentUser.email.split('@')[0];
      }
      return 'User';
    }

    // Sign in or auto-create account with a simple Name & PIN
    async loginWithUsernameOrEmail(identifier, pinOrPassword) {
      if (!this.isConfigured) {
        this.openModal();
        throw new Error('Please configure Firebase first.');
      }
      const raw = identifier.trim().toLowerCase();
      const email = raw.includes('@') ? raw : `${raw}@mastery.app`;
      const pass = pinOrPassword.trim();

      if (pass.length < 6) {
        throw new Error('PIN or Password must be at least 6 characters.');
      }

      try {
        // Try logging in
        const cred = await this.auth.signInWithEmailAndPassword(email, pass);
        return cred.user;
      } catch (err) {
        // If account does not exist yet, auto-create it immediately!
        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
          try {
            const newCred = await this.auth.createUserWithEmailAndPassword(email, pass);
            const name = raw.split('@')[0];
            await newCred.user.updateProfile({ displayName: name.charAt(0).toUpperCase() + name.slice(1) });
            return newCred.user;
          } catch (createErr) {
            if (createErr.code === 'auth/email-already-in-use') {
              throw new Error('Incorrect PIN or password for this user. Please try again.');
            }
            throw createErr;
          }
        }
        if (err.code === 'auth/wrong-password') {
          throw new Error('Incorrect PIN or password for this user.');
        }
        throw err;
      }
    }

    async logout() {
      if (!this.auth) return;
      if (this.unsubscribeSnapshot) {
        this.unsubscribeSnapshot();
        this.unsubscribeSnapshot = null;
      }
      await this.auth.signOut();
      this.notifyToast('Logged out of cloud account');
    }

    notifyToast(msg) {
      if (typeof window.showToast === 'function') {
        window.showToast(msg);
      } else {
        console.log(msg);
      }
    }

    // --- DOM / UI Management ---
    updateHeaderUI(user, state) {
      const btn = document.getElementById('cloud-sync-btn');
      const dot = document.getElementById('cloud-sync-dot');
      if (dot) {
        dot.className = state === 'synced'
          ? 'w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400'
          : state === 'syncing'
          ? 'w-2.5 h-2.5 rounded-full bg-sky-400 animate-pulse'
          : state === 'error'
          ? 'w-2.5 h-2.5 rounded-full bg-rose-500'
          : 'w-2.5 h-2.5 rounded-full bg-amber-400';
      }

      if (btn) {
        if (user) {
          const name = this.getUserDisplayName();
          btn.innerHTML = `
            <span id="cloud-sync-dot" class="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400"></span>
            <span class="w-5 h-5 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-600 text-white text-[11px] font-bold flex items-center justify-center shrink-0">
              ${name.charAt(0).toUpperCase()}
            </span>
            <span class="text-xs font-semibold text-slate-200 hidden sm:inline max-w-[80px] truncate">${name}</span>
          `;
          btn.title = `Signed in as ${name} (Click to manage sync / switch user)`;
        } else if (state === 'unconfigured') {
          btn.innerHTML = `
            <span id="cloud-sync-dot" class="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
            <span class="text-xs">⚙️</span>
            <span class="text-xs font-medium text-amber-300 hidden sm:inline">Setup Cloud</span>
          `;
          btn.title = 'Click to connect Firebase for multi-user sync';
        } else {
          btn.innerHTML = `
            <span id="cloud-sync-dot" class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
            <span class="text-xs">👤</span>
            <span class="text-xs font-semibold text-slate-300 hidden sm:inline">Log In</span>
          `;
          btn.title = 'Click to sign in or create a user profile';
        }
      }
    }

    updateIndicator(state, text) {
      const dot = document.getElementById('cloud-sync-dot');
      const statusText = document.getElementById('auth-modal-status-text');
      if (dot) {
        dot.className = state === 'synced'
          ? 'w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400'
          : state === 'syncing'
          ? 'w-2.5 h-2.5 rounded-full bg-sky-400 animate-pulse'
          : state === 'error'
          ? 'w-2.5 h-2.5 rounded-full bg-rose-500'
          : 'w-2.5 h-2.5 rounded-full bg-amber-400';
      }
      if (statusText && text) statusText.textContent = text;
    }

    mountModalUI() {
      // Remove legacy cloud sync modal if it exists to replace with the enhanced accounts modal
      const legacyModal = document.getElementById('cloud-sync-modal');
      if (legacyModal) legacyModal.remove();

      const modalHtml = `
      <div id="mastery-auth-modal" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-md hidden items-center justify-center p-4">
        <div class="bg-[#14161f] border border-[#262a37] rounded-3xl max-w-md w-full p-6 space-y-5 shadow-2xl relative text-slate-200">
          
          <!-- Header -->
          <div class="flex items-center justify-between border-b border-[#222532] pb-3">
            <div class="flex items-center gap-2.5">
              <span class="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-base">☁️</span>
              <div>
                <h3 class="text-sm font-bold text-white tracking-wide">Multi-User Cloud Accounts</h3>
                <p class="text-[11px] text-slate-400">Separate database &amp; progress per learner</p>
              </div>
            </div>
            <button onclick="window.masteryAuth.closeModal()" class="w-7 h-7 rounded-lg bg-[#1d202b] hover:bg-[#282d3d] text-slate-400 hover:text-white text-xs flex items-center justify-center cursor-pointer transition">✕</button>
          </div>

          <!-- Status Bar -->
          <div id="auth-modal-status-box" class="bg-[#0b0c10] border border-[#212430] rounded-2xl p-3 flex items-center justify-between text-xs">
            <div class="flex items-center gap-2 truncate">
              <span id="auth-status-dot" class="w-2 h-2 rounded-full bg-slate-500 shrink-0"></span>
              <span id="auth-modal-status-text" class="text-slate-300 truncate font-medium">Checking sync status...</span>
            </div>
            <button id="auth-force-sync-btn" onclick="window.masteryAuth.forceSyncNow()" class="hidden px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/30 text-sky-300 text-[11px] font-semibold cursor-pointer shrink-0">
              Sync Now
            </button>
          </div>

          <!-- STATE 1: Logged In View -->
          <div id="auth-view-logged-in" class="hidden space-y-4">
            <div class="bg-gradient-to-r from-sky-500/10 to-indigo-500/10 border border-sky-500/20 rounded-2xl p-4 flex items-center gap-3.5">
              <div id="auth-user-avatar-badge" class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-sky-500 to-indigo-600 text-white font-bold text-lg flex items-center justify-center shadow-md">
                U
              </div>
              <div class="truncate">
                <div class="text-[10px] uppercase font-bold tracking-wider text-sky-400">Active Account</div>
                <div id="auth-user-name" class="text-base font-bold text-white truncate">Learner</div>
                <div id="auth-user-email" class="text-xs text-slate-400 truncate">user@mastery.app</div>
              </div>
            </div>

            <div class="text-xs text-slate-400 leading-relaxed bg-[#0b0c10] p-3.5 rounded-2xl border border-[#20232e]">
              ✨ <strong>Auto-Saved:</strong> Your progress is continuously saved to your private cloud database. Your login is remembered permanently on this device.
            </div>

            <div class="pt-2 flex gap-2.5">
              <button onclick="window.masteryAuth.logout()" class="flex-1 py-2.5 px-4 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold cursor-pointer transition">
                🚪 Log Out / Switch User
              </button>
              <button onclick="window.masteryAuth.closeModal()" class="py-2.5 px-5 rounded-xl bg-[#222634] hover:bg-[#2d3245] text-white text-xs font-semibold cursor-pointer transition">
                Close
              </button>
            </div>
          </div>

          <!-- STATE 2: Log In / Sign Up Form -->
          <div id="auth-view-logged-out" class="hidden space-y-4">
            <div class="text-xs text-slate-300 leading-relaxed">
              Log in to sync your progress across phone and PC, or give your friends their own account so everyone has a separate database.
            </div>

            <form onsubmit="event.preventDefault(); window.masteryAuth.handleFormLogin();" class="space-y-3">
              <div>
                <label class="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Name or Email</label>
                <input id="auth-input-id" type="text" placeholder="e.g. Alex (or alex@gmail.com)" required autocomplete="username" class="w-full px-3.5 py-2.5 rounded-xl bg-[#0b0c10] border border-[#242835] text-white text-xs focus:outline-none focus:border-sky-400 transition" />
              </div>
              <div>
                <label class="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">PIN or Password (min 6 chars)</label>
                <input id="auth-input-pin" type="password" placeholder="e.g. 123456" required autocomplete="current-password" class="w-full px-3.5 py-2.5 rounded-xl bg-[#0b0c10] border border-[#242835] text-white text-xs focus:outline-none focus:border-sky-400 transition" />
              </div>

              <div id="auth-login-error" class="hidden text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-xl"></div>

              <button type="submit" id="auth-submit-btn" class="w-full py-2.5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white text-xs font-bold shadow-lg shadow-sky-500/20 transition cursor-pointer">
                Sign In / Create Account
              </button>
            </form>

            <div class="text-[11px] text-slate-400 text-center">
              💡 <em>New user?</em> Just enter your name &amp; a 6-digit PIN &mdash; it creates your account instantly with no email confirmation needed!
            </div>
          </div>

          <!-- STATE 3: Setup Firebase Config (Only shows if config is missing) -->
          <div id="auth-view-unconfigured" class="hidden space-y-3">
            <div class="bg-amber-500/10 border border-amber-500/20 p-3.5 rounded-2xl text-xs text-amber-200 leading-relaxed">
              ⚙️ <strong>Firebase Project Required</strong><br>
              To allow each friend to have their own separate database and permanent login, connect your free Google Firebase project.
            </div>

            <div>
              <label class="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Paste Firebase Config JSON</label>
              <textarea id="auth-config-json" rows="4" placeholder='{ "apiKey": "AIzaSy...", "projectId": "thai-mastery", ... }' class="w-full p-3 rounded-xl bg-[#0b0c10] border border-[#242835] text-white font-mono text-[11px] focus:outline-none focus:border-amber-400 transition"></textarea>
            </div>

            <button onclick="window.masteryAuth.handleSaveConfig()" class="w-full py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-[#0b0c10] text-xs font-bold transition cursor-pointer">
              Save Firebase Configuration
            </button>
          </div>

        </div>
      </div>
      `;

      document.body.insertAdjacentHTML('beforeend', modalHtml);

      // Re-bind navbar cloud button if present
      const cloudBtn = document.getElementById('cloud-sync-btn');
      if (cloudBtn) {
        cloudBtn.onclick = () => this.openModal();
      }
    }

    openModal() {
      const modal = document.getElementById('mastery-auth-modal');
      if (!modal) return;
      modal.classList.remove('hidden');
      modal.classList.add('flex');

      if (!this.isConfigured) {
        document.getElementById('auth-view-unconfigured').classList.remove('hidden');
        document.getElementById('auth-view-logged-in').classList.add('hidden');
        document.getElementById('auth-view-logged-out').classList.add('hidden');
        this.updateIndicator('error', 'Firebase not yet configured');
      } else if (this.currentUser) {
        this.updateModalLoggedInUI(this.currentUser);
      } else {
        this.updateModalLoggedOutUI();
      }
    }

    closeModal() {
      const modal = document.getElementById('mastery-auth-modal');
      if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
      }
    }

    updateModalLoggedInUI(user) {
      document.getElementById('auth-view-logged-in').classList.remove('hidden');
      document.getElementById('auth-view-logged-out').classList.add('hidden');
      document.getElementById('auth-view-unconfigured').classList.add('hidden');

      const name = this.getUserDisplayName();
      document.getElementById('auth-user-name').textContent = name;
      document.getElementById('auth-user-email').textContent = user.email || 'Cloud synced';
      document.getElementById('auth-user-avatar-badge').textContent = name.charAt(0).toUpperCase();

      document.getElementById('auth-force-sync-btn').classList.remove('hidden');
      this.updateIndicator('synced', `🟢 Synced with cloud (${name})`);
    }

    updateModalLoggedOutUI() {
      document.getElementById('auth-view-logged-in').classList.add('hidden');
      document.getElementById('auth-view-logged-out').classList.remove('hidden');
      document.getElementById('auth-view-unconfigured').classList.add('hidden');
      document.getElementById('auth-force-sync-btn').classList.add('hidden');

      this.updateIndicator('logged_out', 'Offline / Not logged in');
    }

    async handleFormLogin() {
      const idInput = document.getElementById('auth-input-id');
      const pinInput = document.getElementById('auth-input-pin');
      const errBox = document.getElementById('auth-login-error');
      const submitBtn = document.getElementById('auth-submit-btn');

      errBox.classList.add('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Connecting...';

      try {
        await this.loginWithUsernameOrEmail(idInput.value, pinInput.value);
        this.notifyToast(`Welcome, ${idInput.value}! 🚀`);
        this.closeModal();
      } catch (err) {
        console.error(err);
        errBox.textContent = err.message || 'Login failed. Please check your credentials.';
        errBox.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In / Create Account';
      }
    }

    handleSaveConfig() {
      const raw = document.getElementById('auth-config-json').value.trim();
      try {
        let configObj;
        if (raw.startsWith('{')) {
          configObj = JSON.parse(raw);
        } else {
          // Parse JS object literal if user pasted `const firebaseConfig = { ... }`
          const jsonStr = raw
            .replace(/^[^{]*/, '')
            .replace(/[^}]*$/, '')
            .replace(/([a-zA-Z0-9_]+)\s*:/g, '"$1":')
            .replace(/'/g, '"');
          configObj = JSON.parse(jsonStr);
        }
        this.saveConfig(configObj);
      } catch (e) {
        alert('Invalid Firebase configuration JSON. Please check and paste again.');
      }
    }

    async forceSyncNow() {
      if (!this.currentUser) return;
      await this.pushToCloud(true);
      this.notifyToast('☁️ Progress synced to cloud!');
    }
  }

  // Instantiate globally
  window.masteryAuth = new MasteryAuthSync();

  // Initialize once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.masteryAuth.init());
  } else {
    window.masteryAuth.init();
  }

  // Hook into saveState
  const originalSaveState = window.saveState;
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

  // Provide global openCloudSyncModal fallback so existing buttons still work seamlessly
  window.openCloudSyncModal = function () {
    if (window.masteryAuth) {
      window.masteryAuth.openModal();
    }
  };
})();
