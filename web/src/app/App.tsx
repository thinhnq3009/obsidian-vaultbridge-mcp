import { useSearchParams } from "react-router";
import { LoginShell } from "../components/layouts/LoginShell.js";
import { LoginForm, previewStates } from "../features/auth/LoginForm.js";
import type { PreviewState } from "../features/auth/LoginForm.js";

export function App() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("state");
  const state: PreviewState = previewStates.find((value) => value === requested) ?? "default";
  return <LoginShell controls={
      <div className="vb-state-control vb-muted text-xs">
        <label htmlFor="preview-state" className="sr-only">Preview state</label>
        <span aria-hidden="true">Preview</span>
        <select id="preview-state" value={state} onChange={(event) => { setParams({ state: event.target.value }, { replace: true }); }}>
          {previewStates.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
    }>
    <div className="vb-reference">
      <LoginForm key={state} state={state} />
    </div>
  </LoginShell>;
}
