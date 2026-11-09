import type { ReactNode } from "react";
import { Blocks, LockKeyhole, ShieldCheck } from "lucide-react";
import { BrandMark, BrandName } from "../Brand.js";

export function LoginShell({ children, controls }: { children: ReactNode; controls?: ReactNode }) {
  return (
    <div className="vb-login-shell">
      <div className="vb-login-art" role="img" aria-label="Obsidian crystal glowing cyan and violet above a mountain lake" />
      <header className="vb-page-header">
        <a className="vb-wordmark inline-flex items-center gap-2" href="#main"><BrandMark /> VaultBridge</a>
        <div className="flex items-center gap-6">
          <nav className="vb-navigation" aria-label="Product">
            <a href="#product">Product</a>
            <a href="#security">Security</a>
            <a href="https://github.com/thinhnq3009/obsidian-vaultbridge-mcp" target="_blank" rel="noopener noreferrer">Community</a>
            <a href="#local-help">Help</a>
          </nav>
          {controls}
        </div>
      </header>
      <main id="main" className="vb-login-layout" tabIndex={-1}>
        <section id="product" className="vb-marketing" aria-label="About VaultBridge">
          <p className="vb-marketing-eyebrow">YOUR KNOWLEDGE. YOUR CONTROL.</p>
          <h2 className="vb-marketing-title"><BrandName /></h2>
          <p className="vb-marketing-description">Secure access to your local<br />knowledge workspace.</p>
          <ul id="security" className="vb-benefits">
            <li>
              <span className="vb-benefit-icon"><LockKeyhole aria-hidden="true" /></span>
              <div><h3>Private by design</h3><p>Your vault stays on your device.</p></div>
            </li>
            <li>
              <span className="vb-benefit-icon"><Blocks aria-hidden="true" /></span>
              <div><h3>Access on your terms</h3><p>Explicit consent. Scoped permissions.</p></div>
            </li>
            <li>
              <span className="vb-benefit-icon"><ShieldCheck aria-hidden="true" /></span>
              <div><h3>Yours to control</h3><p>Your knowledge. Your connections.</p></div>
            </li>
          </ul>
        </section>
        {children}
      </main>
      <footer className="vb-page-footer vb-muted text-xs">
        NOTES <span>·</span> IDEAS <span>·</span> PLANS <span>·</span> KNOWLEDGE <span>·</span> YOURS BY DESIGN
      </footer>
    </div>
  );
}
