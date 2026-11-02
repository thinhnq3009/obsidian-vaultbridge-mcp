/** User-supplied transparent master. Never recreate the mark with an icon/font. */
export function BrandMark({ className = "" }: { className?: string }) {
  return <img src={`${import.meta.env.BASE_URL}assets/vaultbridge-crystal-mark.png`}
    width={64} height={64} className={className} alt="" />;
}

export function BrandName() {
  return <>Vault<span className="vb-brand-gradient">Bridge</span></>;
}
