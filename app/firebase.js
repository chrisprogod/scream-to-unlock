// Firebase connection for the live stats feature.
// Loaded as a module (<script type="module">) because it uses `import`.

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import { getDatabase, ref, set } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-database.js";

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

const db = getDatabase(app);

// Test write: proves the app can reach the database.
set(ref(db, "test"), { hello: "from my laptop", time: Date.now() })
  .then(() => console.log("wrote to firebase!"))
  .catch((err) => console.error("firebase write failed:", err));
