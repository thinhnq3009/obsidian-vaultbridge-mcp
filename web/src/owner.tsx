import { createRoot } from "react-dom/client";
import { OwnerLogin } from "./features/auth/OwnerLogin.js";
import "./styles/index.css";

// get-nonce (used by Radix's scroll lock) reads this global without requiring
// unsafe-inline styles or scripts. The server generates a fresh nonce per page.
Object.assign(globalThis, {
  __webpack_nonce__: document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content,
});
const root = document.getElementById("root");
if (!root) throw new Error("Owner login root missing");
createRoot(root).render(<OwnerLogin />);
