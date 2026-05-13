import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  setDoc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig, TRIP_DOC_PATH, isFirebaseConfigured } from "./firebase-config.js";
import { defaultTripState } from "./seed-data.js";

const ALLOWED_GOOGLE_EMAILS = [
  "jakenelsonfernandez@gmail.com",
  "sjthai37@gmail.com",
].map((e) => e.toLowerCase());

function isAllowedGoogleUser(user) {
  const email = (user?.email || "").toLowerCase();
  return email.length > 0 && ALLOWED_GOOGLE_EMAILS.includes(email);
}

const itineraryList = document.getElementById("itineraryList");

const taskList = document.getElementById("taskList");
const syncBanner = document.getElementById("syncBanner");
const authBar = document.getElementById("authBar");
const btnGoogleSignIn = document.getElementById("btnGoogleSignIn");
const btnSignOut = document.getElementById("btnSignOut");
const userLabel = document.getElementById("userLabel");
const userPhoto = document.getElementById("userPhoto");
const btnAddItinerary = document.getElementById("btnAddItinerary");
const btnAddTask = document.getElementById("btnAddTask");

let db;
let auth;
let provider;
let tripRef;
let saveTimer = null;
let applyingRemote = false;
let lastRemoteJson = "";
let firestoreUnsub = null;
let addButtonsWired = false;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setBanner(text, kind) {
  if (!syncBanner) return;
  syncBanner.textContent = text;
  syncBanner.dataset.kind = kind;
  syncBanner.hidden = false;
}

function itemRow(listId, row) {
  const isItinerary = listId === "itineraryList";
  const el = document.createElement("div");
  el.className = "editable-item";
  el.dataset.itemId = row.id;
  const controls = isItinerary
    ? `<div class="item-controls"><button type="button" class="control-btn" data-action="up">▲</button><button type="button" class="control-btn" data-action="down">▼</button></div>`
    : "";
  el.innerHTML = `${controls}<div class="item-content"><input class="title-input" value="${escapeAttr(row.title)}"><textarea class="desc-input">${escapeHtml(row.desc)}</textarea></div><button type="button" class="btn-remove">Delete</button>`;
  el.querySelector(".btn-remove").addEventListener("click", () => {
    el.remove();
    scheduleSave();
  });
  el.querySelectorAll(".control-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "up") moveUp(el);
      if (btn.dataset.action === "down") moveDown(el);
      scheduleSave();
    });
  });
  el.querySelector(".title-input").addEventListener("input", scheduleSave);
  el.querySelector(".desc-input").addEventListener("input", scheduleSave);
  return el;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readList(container) {
  return [...container.querySelectorAll(".editable-item")].map((el) => ({
    id: el.dataset.itemId || uid(),
    title: el.querySelector(".title-input")?.value?.trim() || "",
    desc: el.querySelector(".desc-input")?.value?.trim() || "",
  }));
}

function renderState(state) {
  applyingRemote = true;
  itineraryList.innerHTML = "";
  taskList.innerHTML = "";
  state.itinerary.forEach((row) => itineraryList.appendChild(itemRow("itineraryList", row)));
  state.tasks.forEach((row) => taskList.appendChild(itemRow("taskList", row)));
  applyingRemote = false;
}

function renderSignedOutPlanner() {
  applyingRemote = true;
  const msg =
    '<p class="auth-gate-msg">Sign in with Google above to view and edit the shared itinerary and tasks.</p>';
  itineraryList.innerHTML = msg;
  taskList.innerHTML = msg;
  applyingRemote = false;
}

function moveUp(item) {
  if (item.previousElementSibling) item.parentNode.insertBefore(item, item.previousElementSibling);
}

function moveDown(item) {
  if (item.nextElementSibling) item.parentNode.insertBefore(item.nextElementSibling, item);
}

function scheduleSave() {
  if (applyingRemote || !tripRef || !auth?.currentUser || !isAllowedGoogleUser(auth.currentUser)) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persistNow(), 600);
}

async function persistNow() {
  if (!tripRef || applyingRemote || !auth?.currentUser || !isAllowedGoogleUser(auth.currentUser)) return;
  const payload = {
    version: 1,
    itinerary: readList(itineraryList),
    tasks: readList(taskList),
    updatedAt: new Date().toISOString(),
  };
  try {
    setBanner("Saving…", "pending");
    await setDoc(tripRef, payload, { merge: true });
    setBanner("Saved to cloud", "ok");
  } catch (e) {
    console.error(e);
    setBanner(`Save failed: ${e.message || e}`, "err");
  }
}

function setPlannerDisabled(disabled) {
  [btnAddItinerary, btnAddTask].forEach((b) => {
    if (b) b.disabled = disabled;
  });
}

function updateAuthUi(user) {
  if (!authBar) return;
  if (!isFirebaseConfigured()) {
    authBar.hidden = true;
    return;
  }
  authBar.hidden = false;
  if (user) {
    btnGoogleSignIn.hidden = true;
    btnSignOut.hidden = false;
    userLabel.hidden = false;
    userLabel.textContent = user.displayName || user.email || "Signed in";
    if (user.photoURL && userPhoto) {
      userPhoto.hidden = false;
      userPhoto.src = user.photoURL;
      userPhoto.alt = "";
    } else if (userPhoto) {
      userPhoto.hidden = true;
      userPhoto.removeAttribute("src");
    }
    setPlannerDisabled(false);
  } else {
    btnGoogleSignIn.hidden = false;
    btnSignOut.hidden = true;
    userLabel.hidden = true;
    if (userPhoto) {
      userPhoto.hidden = true;
      userPhoto.removeAttribute("src");
    }
    setPlannerDisabled(true);
  }
}

function wireAddButtons(requireAuth) {
  if (addButtonsWired) return;
  addButtonsWired = true;
  btnAddItinerary?.addEventListener("click", () => {
    if (requireAuth && (!auth?.currentUser || !isAllowedGoogleUser(auth.currentUser))) {
      setBanner("Sign in with Google to edit the trip.", "warn");
      return;
    }
    itineraryList.appendChild(itemRow("itineraryList", { id: uid(), title: "", desc: "" }));
    scheduleSave();
  });
  btnAddTask?.addEventListener("click", () => {
    if (requireAuth && (!auth?.currentUser || !isAllowedGoogleUser(auth.currentUser))) {
      setBanner("Sign in with Google to edit the trip.", "warn");
      return;
    }
    taskList.appendChild(itemRow("taskList", { id: uid(), title: "", desc: "" }));
    scheduleSave();
  });
}

function detachFirestoreListener() {
  if (firestoreUnsub) {
    firestoreUnsub();
    firestoreUnsub = null;
  }
  clearTimeout(saveTimer);
  saveTimer = null;
  tripRef = null;
  lastRemoteJson = "";
}

function stopTripSync() {
  detachFirestoreListener();
  renderSignedOutPlanner();
}

async function startTripSync() {
  if (!auth?.currentUser || !db) return;
  detachFirestoreListener();
  tripRef = doc(db, TRIP_DOC_PATH[0], TRIP_DOC_PATH[1]);

  const snap = await getDoc(tripRef);
  if (!snap.exists()) {
    await setDoc(tripRef, { ...defaultTripState, updatedAt: new Date().toISOString() });
  }

  firestoreUnsub = onSnapshot(tripRef, (docSnap) => {
    if (!docSnap.exists()) return;
    const data = docSnap.data();
    const state = {
      version: data.version || 1,
      itinerary: Array.isArray(data.itinerary) ? data.itinerary : defaultTripState.itinerary,
      tasks: Array.isArray(data.tasks) ? data.tasks : defaultTripState.tasks,
    };
    const json = JSON.stringify(state);
    if (json === lastRemoteJson) return;
    const active = document.activeElement;
    const typingInPlanner =
      active &&
      active.matches(".title-input, .desc-input") &&
      (itineraryList.contains(active) || taskList.contains(active));
    if (typingInPlanner && docSnap.metadata.hasPendingWrites === false) {
      setBanner("Cloud updated — click away from a field to apply latest.", "warn");
      return;
    }
    lastRemoteJson = json;
    renderState(state);
    setBanner(docSnap.metadata.hasPendingWrites ? "Saving…" : "Synced with Firebase", "ok");
  });
}

window.openTab = function openTab(evt, tabName) {
  const tabcontent = document.getElementsByClassName("tab-content");
  for (let i = 0; i < tabcontent.length; i++) {
    tabcontent[i].style.display = "none";
    tabcontent[i].classList.remove("active");
  }
  const tablinks = document.getElementsByClassName("tab-btn");
  for (let i = 0; i < tablinks.length; i++) tablinks[i].classList.remove("active");
  document.getElementById(tabName).style.display = "block";
  document.getElementById(tabName).classList.add("active");
  evt.currentTarget.classList.add("active");
};

function initOfflineMode() {
  if (authBar) authBar.hidden = true;
  setPlannerDisabled(false);
  renderState(defaultTripState);
  setBanner("Firebase not configured — edit js/firebase-config.js, then refresh.", "warn");
  wireAddButtons(false);
}

function initFirebaseWithGoogleAuth() {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  if (authBar) authBar.hidden = false;
  updateAuthUi(null);
  renderSignedOutPlanner();
  setBanner("Sign in with Google to load the shared trip.", "warn");
  wireAddButtons(true);

  btnGoogleSignIn?.addEventListener("click", async () => {
    try {
      setBanner("Opening Google sign-in…", "pending");
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error(e);
      if (e.code === "auth/popup-closed-by-user") {
        setBanner("Sign-in cancelled.", "warn");
        return;
      }
      if (e.code === "auth/unauthorized-domain") {
        setBanner(
          "This site’s domain is not authorized for Google sign-in. In Firebase Console: Authentication → Settings → Authorized domains → add your github.io host.",
          "err"
        );
        return;
      }
      setBanner(`Sign-in failed: ${e.message || e.code || e}`, "err");
    }
  });

  btnSignOut?.addEventListener("click", async () => {
    try {
      await signOut(auth);
      setBanner("Signed out.", "warn");
    } catch (e) {
      console.error(e);
      setBanner(`Sign-out failed: ${e.message || e}`, "err");
    }
  });

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      updateAuthUi(null);
      stopTripSync();
      setBanner("Sign in with Google to load the shared trip.", "warn");
      return;
    }
    if (!isAllowedGoogleUser(user)) {
      setBanner("This Google account is not authorized for this trip.", "err");
      void signOut(auth);
      updateAuthUi(null);
      stopTripSync();
      return;
    }
    updateAuthUi(user);
    setBanner("Loading trip...", "pending");
    startTripSync().catch((e) => {
      console.error(e);
      setBanner(`Could not load trip: ${e.message || e}. Check Firestore rules.`, "err");
    });
  });

}

if (!isFirebaseConfigured()) {
  initOfflineMode();
} else {
  try {
    initFirebaseWithGoogleAuth();
  } catch (e) {
    console.error(e);
    initOfflineMode();
    setBanner(`Firebase error: ${e.message || e}`, "err");
  }
}
