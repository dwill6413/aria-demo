import { useRouter } from 'next/router';

const LAST_UPDATED = 'May 28, 2026';

const Section = ({ title, children }) => (
  <div style={{ marginBottom: '32px' }}>
    <h2 style={{ fontSize: '16px', fontWeight: '700', color: '#fff', margin: '0 0 12px', paddingBottom: '8px', borderBottom: '1px solid #222' }}>{title}</h2>
    <div style={{ color: '#888', fontSize: '14px', lineHeight: '1.8' }}>{children}</div>
  </div>
);

const P = ({ children }) => <p style={{ margin: '0 0 10px' }}>{children}</p>;
const Li = ({ children }) => <li style={{ margin: '4px 0', paddingLeft: '4px' }}>{children}</li>;

export default function Terms() {
  const router = useRouter();

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff' }}>

      {/* Header */}
      <div style={{ background: '#111', borderBottom: '1px solid #222', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }} onClick={() => router.push('/')}>
          <span style={{ fontSize: '20px' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px' }}>ARIA</span>
          <span style={{ background: '#00ff44', color: '#000', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
        </div>
        <button onClick={() => router.back()} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>← Back</button>
      </div>

      <div style={{ maxWidth: '760px', margin: '0 auto', padding: '48px 24px' }}>

        {/* Title */}
        <div style={{ marginBottom: '40px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: '700', margin: '0 0 8px' }}>Terms of Service</h1>
          <p style={{ color: '#555', fontSize: '13px', margin: 0 }}>Last updated: {LAST_UPDATED} · ARIA Beta Platform</p>
        </div>

        {/* Important notice */}
        <div style={{ background: '#0a0a00', border: '1px solid #3a3000', borderRadius: '12px', padding: '20px', marginBottom: '40px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{ fontSize: '18px' }}>⚠️</span>
            <span style={{ fontWeight: '700', fontSize: '15px', color: '#ffaa00' }}>Important — Please Read Carefully</span>
          </div>
          <p style={{ color: '#888', fontSize: '13px', margin: 0, lineHeight: '1.7' }}>
            ARIA is a non-custodial blockchain platform. By using ARIA, you acknowledge that all transactions are executed directly on the Sui blockchain, ARIA has no ability to reverse or recover transactions, and you are solely responsible for the security of your wallet and funds.
          </p>
        </div>

        <Section title="1. Acceptance of Terms">
          <P>By accessing or using the ARIA platform ("ARIA", "we", "us"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use ARIA.</P>
          <P>These terms apply to all users of the ARIA platform, including guests booking properties and hosts listing properties.</P>
        </Section>

        <Section title="2. Non-Custodial Platform Disclosure">
          <P>ARIA is a <strong style={{ color: '#fff' }}>non-custodial platform</strong>. This means:</P>
          <ul style={{ paddingLeft: '20px', margin: '8px 0' }}>
            <Li>ARIA does not hold, control, or have access to your funds at any time</Li>
            <Li>All payments are executed directly on the Sui blockchain via smart contracts</Li>
            <Li>ARIA has no ability to reverse, pause, freeze, or recover any transaction once confirmed on-chain</Li>
            <Li>Security deposits are held by smart contract, not by ARIA</Li>
            <Li>You are solely responsible for the security of your wallet, private keys, and account credentials</Li>
            <Li>Loss of access to your wallet may result in permanent loss of funds</Li>
          </ul>
        </Section>

        <Section title="3. Blockchain and Smart Contract Risks">
          <P>By using ARIA, you acknowledge and accept the following risks:</P>
          <ul style={{ paddingLeft: '20px', margin: '8px 0' }}>
            <Li><strong style={{ color: '#ccc' }}>Smart Contract Risk:</strong> Smart contracts may contain bugs or vulnerabilities. ARIA makes no warranty that contracts are free of errors.</Li>
            <Li><strong style={{ color: '#ccc' }}>Network Risk:</strong> The Sui blockchain may experience outages, congestion, or forks that affect transactions.</Li>
            <Li><strong style={{ color: '#ccc' }}>Wallet Risk:</strong> You are responsible for securing your wallet. ARIA cannot recover lost wallets or private keys.</Li>
            <Li><strong style={{ color: '#ccc' }}>Finality Risk:</strong> Confirmed blockchain transactions are irreversible. ARIA cannot undo payments or deposits.</Li>
            <Li><strong style={{ color: '#ccc' }}>Regulatory Risk:</strong> Cryptocurrency regulations vary by jurisdiction and may change. You are responsible for compliance with local laws.</Li>
          </ul>
        </Section>

        <Section title="4. Short-Term Rental Compliance">
          <P>ARIA is a technology platform only. We do not verify, endorse, or guarantee:</P>
          <ul style={{ paddingLeft: '20px', margin: '8px 0' }}>
            <Li>That any property listing is legally permitted for short-term rental in its jurisdiction</Li>
            <Li>That hosts hold required licenses, permits, or insurance</Li>
            <Li>That properties meet local health, safety, or zoning requirements</Li>
          </ul>
          <P>Hosts are solely responsible for complying with all applicable local, state, and federal laws governing short-term rentals, including licensing, permitting, occupancy tax remittance, and insurance requirements. ARIA provides tax collection tools only — hosts are responsible for remitting collected taxes to the appropriate authorities.</P>
          <P>Guests are responsible for verifying that their intended use of a property complies with local laws and HOA or lease restrictions.</P>
        </Section>

        <Section title="5. Occupancy Tax">
          <P>ARIA collects an 8% occupancy tax on all bookings on behalf of hosts. This tax is displayed transparently in the booking breakdown. Hosts are solely responsible for remitting these taxes to the appropriate local tax authority. ARIA provides remittance tracking tools but does not remit taxes on behalf of hosts and makes no representation regarding tax obligations in any jurisdiction.</P>
        </Section>

        <Section title="6. Platform Fees">
          <P>ARIA charges a 3% platform fee on the subtotal of each booking (excluding deposits). This fee is non-refundable once a booking is confirmed. No fee is charged on security deposits. All fees are displayed transparently before booking confirmation.</P>
        </Section>

        <Section title="7. Cancellations and Refunds">
          <P>Cancellation policies are executed automatically via smart contract:</P>
          <ul style={{ paddingLeft: '20px', margin: '8px 0' }}>
            <Li>Cancellations made at least 24 hours before check-in: full refund of stay cost</Li>
            <Li>Cancellations made within 24 hours of check-in: 50% refund of stay cost</Li>
            <Li>Security deposits are returned after checkout at host discretion, subject to inspection</Li>
            <Li>ARIA platform fees are non-refundable</Li>
          </ul>
          <P>Because transactions execute on-chain, refunds are processed as new transactions. ARIA cannot guarantee refund timing, which depends on Sui network conditions.</P>
        </Section>

        <Section title="8. User Responsibilities">
          <P>You agree to:</P>
          <ul style={{ paddingLeft: '20px', margin: '8px 0' }}>
            <Li>Provide accurate information when creating your account and any host profile</Li>
            <Li>Maintain the security of your Google account and Sui wallet</Li>
            <Li>Comply with all applicable laws in your jurisdiction</Li>
            <Li>Not use ARIA for any unlawful purpose</Li>
            <Li>Not attempt to circumvent ARIA's security measures or smart contracts</Li>
          </ul>
        </Section>

        <Section title="9. No Financial Advice">
          <P>Nothing on the ARIA platform constitutes financial, investment, legal, or tax advice. ARIA does not provide recommendations regarding cryptocurrency, SuiUSD, or any financial product. All financial and legal decisions are your sole responsibility. Consult qualified professionals before making financial or legal decisions.</P>
        </Section>

        <Section title="10. Limitation of Liability">
          <P>To the maximum extent permitted by law, ARIA and its operators shall not be liable for:</P>
          <ul style={{ paddingLeft: '20px', margin: '8px 0' }}>
            <Li>Loss of funds due to smart contract vulnerabilities, blockchain failures, or wallet compromise</Li>
            <Li>Damages arising from property stays booked through the platform</Li>
            <Li>Tax liability, fines, or penalties arising from host non-compliance</Li>
            <Li>Indirect, incidental, consequential, or punitive damages of any kind</Li>
            <Li>Losses exceeding the amount of platform fees paid in the preceding 30 days</Li>
          </ul>
        </Section>

        <Section title="11. Dispute Resolution">
          <P>Disputes between guests and hosts are between those parties. ARIA is not a party to rental agreements and does not mediate disputes. Deposit release decisions are made by hosts through the platform. ARIA has no authority to override host decisions regarding deposits.</P>
          <P>Any disputes with ARIA must be resolved through binding arbitration rather than in court, except where prohibited by law.</P>
        </Section>

        <Section title="12. Privacy and Data">
          <P>ARIA collects minimal personal data necessary to operate the platform (name, email, Sui wallet address). Booking receipts are stored permanently on the Walrus decentralized storage network. By using ARIA, you consent to this storage. Sensitive host compliance data (tax ID, permits) is stored securely and never exposed in API responses or logs.</P>
        </Section>

        <Section title="13. Beta Platform Disclaimer">
          <P>ARIA is currently in beta. The platform is provided "as is" without warranty of any kind. Features may change, be removed, or experience downtime without notice. Do not use ARIA for transactions you cannot afford to lose during the beta period. Smart contracts are on Sui testnet and use test assets only.</P>
        </Section>

        <Section title="14. Changes to Terms">
          <P>ARIA reserves the right to update these terms at any time. Continued use of the platform after changes constitutes acceptance of the new terms. Material changes will be communicated via email to registered users.</P>
        </Section>

        <Section title="15. Contact">
          <P>For questions about these terms, contact ARIA at the support address provided on the platform. For legal notices, use the registered business address.</P>
        </Section>

        {/* Footer CTA */}
        <div style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '24px', textAlign: 'center', marginTop: '40px' }}>
          <p style={{ color: '#888', fontSize: '13px', margin: '0 0 16px' }}>By using ARIA, you agree to these Terms of Service.</p>
          <button onClick={() => router.push('/')} style={{ background: '#00ff44', color: '#000', border: 'none', borderRadius: '8px', padding: '12px 32px', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>
            Back to ARIA
          </button>
        </div>

      </div>
    </div>
  );
}
