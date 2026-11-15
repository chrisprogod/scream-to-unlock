// Firebase connection for the live stats feature.
// Loaded as a module (<script type="module">) because it uses `import`.

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import { getDatabase, ref, push } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-database.js";

// Not a secret: this only identifies the project. Access is controlled by the
// database Rules in the Firebase console.
const firebaseConfig = {
  apiKey: "AIzaSyC7YqQnxMsn-H2GQWpfXCCiGNGy61QjyfY",
  authDomain: "scream-to-unlock.firebaseapp.com",
  databaseURL: "https://scream-to-unlock-default-rtdb.firebaseio.com",
  projectId: "scream-to-unlock",
  storageBucket: "scream-to-unlock.firebasestorage.app",
  messagingSenderId: "628414381095",
  appId: "1:628414381095:web:18a7e98706c980f7dfe202",
};

const app = initializeApp(firebaseConfig);

export const db = getDatabase(app);

// Each laptop gets a random name like "Screamer #4821". It's saved in
// localStorage so the same laptop keeps the same name between runs.
function getScreamerName() {
  const fresh = `Screamer #${Math.floor(Math.random() * 9000) + 1000}`;
  try {
    let name = localStorage.getItem("screamerName");
    if (!name) {
      name = fresh;
      localStorage.setItem("screamerName", name);
    }
    return name;
  } catch {
    return fresh;
  }
}
const myName = getScreamerName();

// Called from renderer.js as window.sendEvent?.({ type, db, phrase }).
// Fills in the rest of the contract (name, time, bot) and adds it to the
// "events" list. push() = add a new child with a unique key (never overwrites).
window.sendEvent = (item) => {
  const event = {
    name: myName,
    db: null,
    phrase: null,
    time: Date.now(),
    bot: false,
    ...item, // whatever renderer.js passed wins over the defaults above
  };
  push(ref(db, "events"), event)
    .catch((err) => console.error("firebase event failed:", err));
};

console.log(`firebase ready as ${myName}`);
