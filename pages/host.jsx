import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { authFetch } from '../lib/authFetch';
import { useWalletBalance } from '../lib/useWalletBalance';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Mirrors escrow.mjs's normalizeAddr — lets us compare a property's
// hostAddress against the logged-in host's own Sui address regardless of
// case or leading-zero padding differences between the two sources.
const normalizeAddr = (a) => {
  if (!a) return '';
  let h = String(a).toLowerCase();
  if (!h.startsWith('0x')) h = '0x' + h;
  const body = h.slice(2).replace(/^0+/, '') || '0';
  return '0x' + body;
};

const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const fmtDay = (d) => {
  const s = String(d).slice(0, 10);
  const [y, mo, day] = s.split('-').map(Number);
  if (!y || !mo || !day) return fmtDate(d);
  return new Date(y, mo - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const fmtDateTime = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// PROPERTY_DISPLAY holds cosmetic/display-only fields (image, location,
// beds/baths, tag). `price` here is a fallback default only — on mount we
// fetch the authoritative value from GET /properties (catalog.mjs) and
// merge it in, so this page can't drift from what the server actually
// charges (Phase 2a fix; mirrors the same change in pages/index.jsx).
const PROPERTY_DISPLAY = [
  { id: 1, title: 'Oceanfront Villa', location: 'Miami Beach, FL', price: 285, beds: 4, baths: 3, tag: 'Beachfront', image: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=600&q=80' },
  { id: 2, title: 'Downtown Loft', location: 'Austin, TX', price: 145, beds: 2, baths: 1, tag: 'City View', image: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=80' },
  { id: 3, title: 'Mountain Cabin', location: 'Asheville, NC', price: 195, beds: 3, baths: 2, tag: 'Nature', image: 'https://images.unsplash.com/photo-1542718610-a1d656d1884c?w=600&q=80' },
  { id: 4, title: 'Desert Retreat', location: 'Scottsdale, AZ', price: 225, beds: 3, baths: 2, tag: 'Pool', image: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=600&q=80' },
  { id: 5, title: 'Lake House', location: 'Lake Tahoe, CA', price: 320, beds: 5, baths: 4, tag: 'Waterfront', image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&q=80' },
  { id: 6, title: 'Historic Brownstone', location: 'Brooklyn, NY', price: 175, beds: 2, baths: 2, tag: 'Historic', image: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=600&q=80' },
];

// Fallback thumbnail for a host-created listing that has no photos uploaded
// yet — keeps the listings grid from showing a broken <img>.
const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1560448204-603b3fc33ddc?w=600&q=80';

// Phase 3a: a blank draft for the manual-entry path of Add Property — same
// shape extractListingFields() returns, so the review form and its submit
// handler work identically whether the draft came from AI extraction or a
// host just typing into an empty form.
const blankDraft = () => ({
  title: '', description: '', location: '', price: 150, beds: 1, baths: 1, maxGuests: 2,
  tag: 'New Listing', images: [], taxRate: 0.08, taxJurisdiction: 'Unknown', sourceUrl: '', importSource: 'manual'
});

export default function Host() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [copiedId, setCopiedId] = useState(null);
  const [icalInputs, setIcalInputs] = useState({});
  const [icalSaving, setIcalSaving] = useState({});
  const [icalSaved, setIcalSaved] = useState({});
  const [releasingId, setReleasingId] = useState(null);
  const [messageCounts, setMessageCounts] = useState({});
  const [addrCopied, setAddrCopied] = useState(false);
  const [properties, setProperties] = useState(PROPERTY_DISPLAY);
  // Phase 2c: per-listing resale opt-in (Rail 1) + premium cap (Rail 2).
  const [resaleSettings, setResaleSettings] = useState({}); // { [propertyId]: { transferAllowed, maxPremiumBps } }
  const [resaleEnabled, setResaleEnabled] = useState(false); // global flag (RESALE_ENABLED)
  const [savingResale, setSavingResale] = useState({});      // { [propertyId]: true } while saving
  // P4: per-listing self check-in settings.
  // { [propertyId]: { checkInType: 'front_desk'|'self', instructions: string, saving: bool, saved: bool } }
  const [checkInSettings, setCheckInSettings] = useState({});

  // Phase 3a: Add Property (manual entry + AI-paste import + bulk import)
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState('import'); // 'import' | 'manual' | 'bulk'
  const [importUrl, setImportUrl] = useState('');
  const [importText, setImportText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [draft, setDraft] = useState(null); // reviewed/edited fields, ready to publish
  const [publishing, setPublishing] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [bulkBlocks, setBulkBlocks] = useState([{ url: '', text: '' }]);
  const [bulkExtracting, setBulkExtracting] = useState(false);
  const [bulkDrafts, setBulkDrafts] = useState([]); // [{ draft|error, publishing, published }]
  // editingId: null while adding a new listing; set to a property id while
  // the Add Property modal is reused to edit an existing host-created
  // listing (handlePublish branches PATCH vs POST off this).
  const [editingId, setEditingId] = useState(null);
  const [deactivatingId, setDeactivatingId] = useState(null);
  const wallet = useWalletBalance(user?.address);

  const copyAddr = () => {
    navigator.clipboard.writeText(user?.address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  };

  // Tax state
  const [taxData, setTaxData] = useState(null);
  const [taxLoading, setTaxLoading] = useState(false);
  const [remittingId, setRemittingId] = useState(null);
  const [remitModal, setRemitModal] = useState(null);
  const [remitJurisdiction, setRemitJurisdiction] = useState('');
  const [remitNotes, setRemitNotes] = useState('');
  const [taxFilter, setTaxFilter] = useState('all');

  // Applications state
  const [applications, setApplications] = useState([]);
  const [applicationsLoading, setApplicationsLoading] = useState(false);
  const [approvingId, setApprovingId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Phase 2h: guest-identity decrypt modal
  const [identityModal, setIdentityModal] = useState(null); // booking being viewed
  const [identityStatus, setIdentityStatus] = useState('idle'); // idle|loading|signing|decrypting|done|error
  const [identityData, setIdentityData] = useState(null);
  const [identityError, setIdentityError] = useState('');

  useEffect(() => {
    authFetch(`${API}/auth/me`)
      .then(res => res.json())
      .then(async data => {
        if (!data.address) { router.push('/'); return; }
        if (!data.isHost) { router.push('/?error=access_denied'); return; }
        setUser(data);
        const bkRes = await authFetch(`${API}/bookings/all`);
        const bkData = await bkRes.json();
        const bks = bkData.bookings || [];
        setBookings(bks);
        const counts = {};
        await Promise.all(bks.filter(b => b.paymentStatus !== 'cancelled').map(async b => {
          try {
            const r = await authFetch(`${API}/messages/${b.bookingRef}/count`);
            const d = await r.json();
            counts[b.bookingRef] = d.count || 0;
          } catch { counts[b.bookingRef] = 0; }
        }));
        setMessageCounts(counts);
        const rvRes = await authFetch(`${API}/reviews/all`);
        const rvData = await rvRes.json();
        setReviews(rvData.reviews || []);
        loadApplications(true);
        try {
          const rsRes = await authFetch(`${API}/host/resale-settings`);
          const rsData = await rsRes.json();
          if (rsData.settings) setResaleSettings(rsData.settings);
          setResaleEnabled(!!rsData.resaleEnabled);
        } catch {}
        // P4: load check-in type + instructions for each property (DB-only).
        // Lazy per-property — only load for properties the host created (source==='db').
        // Catalog properties don't have DB rows to update.
        setLoading(false);
      })
      .catch(() => { router.push('/'); });

    refreshProperties();
  }, []);

  // Merge authoritative price/title from catalog.mjs (Phase 2a fix) for the 6
  // fixed demo properties — cosmetic fields (image, location, beds/baths, tag)
  // stay local for those. For host-created/imported listings (Phase 3a), which
  // aren't in PROPERTY_DISPLAY at all, synthesize display fields from the
  // cosmetic data GET /properties now returns for source==='db' rows, so a
  // newly created listing actually shows up here instead of being silently
  // dropped. Exported so handlePublish/handleBulkPublishOne can re-pull the
  // list after creating a property.
  const refreshProperties = () => {
    fetch(`${API}/properties`).then(r => r.json()).then(d => {
      if (!Array.isArray(d.properties)) return;
      const merged = d.properties.map(p => {
        // Match on source==='catalog', not just id — the host-created
        // `properties` DB table has its own SERIAL starting at 1, so a new
        // listing's id can collide with one of the 6 fixed demo ids (1-6).
        // Matching by id alone would overlay the wrong demo property's
        // location/beds/baths/tag/image onto the new listing.
        const fixed = p.source === 'catalog' ? PROPERTY_DISPLAY.find(f => f.id === p.id) : null;
        if (fixed) return { ...fixed, title: p.title, price: p.price, source: 'catalog', hostAddress: p.hostAddress };
        return {
          id: p.id, title: p.title, price: p.price, source: 'db',
          location: p.location || 'Location not set',
          beds: p.beds ?? 1, baths: p.baths ?? 1,
          maxGuests: p.maxGuests ?? (p.beds ?? 1) * 2,
          tag: p.tag || 'New Listing',
          image: (p.images && p.images[0]) || PLACEHOLDER_IMAGE,
          images: p.images || [],
          description: p.description || '',
          taxRate: p.taxRate ?? 0.08,
          taxJurisdiction: p.taxName || 'Unknown',
          hostAddress: p.hostAddress,
        };
      });
      setProperties(merged);
    }).catch(() => {});
  };

  // Persist a listing's resale opt-in + cap. Optimistic local update, then POST.
  const saveResaleSettings = async (propertyId, next) => {
    setResaleSettings(prev => ({ ...prev, [propertyId]: { ...prev[propertyId], ...next } }));
    setSavingResale(prev => ({ ...prev, [propertyId]: true }));
    try {
      const cur = { transferAllowed: false, maxPremiumBps: 0, ...resaleSettings[propertyId], ...next };
      const res = await authFetch(`${API}/host/property/${propertyId}/resale-settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferAllowed: !!cur.transferAllowed, maxPremiumBps: Number(cur.maxPremiumBps) || 0 }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed');
      setResaleSettings(prev => ({ ...prev, [propertyId]: { transferAllowed: data.transferAllowed, maxPremiumBps: data.maxPremiumBps } }));
    } catch (err) {
      alert(err.message || 'Could not save resale settings');
    }
    setSavingResale(prev => ({ ...prev, [propertyId]: false }));
  };

  // P4: load + save check-in settings per property (DB-source only).
  const loadCheckInSettings = async (propertyId) => {
    if (checkInSettings[propertyId]) return; // already loaded
    // Seed defaults immediately so the block renders while fetching
    setCheckInSettings(prev => ({ ...prev, [propertyId]: { checkInType: 'front_desk', instructions: '', saving: false, saved: false } }));
    try {
      const res = await authFetch(`${API}/host/property/${propertyId}/access-instructions`);
      if (!res.ok) return;
      const data = await res.json();
      setCheckInSettings(prev => ({ ...prev, [propertyId]: { checkInType: data.checkInType || 'front_desk', instructions: data.instructions || '', saving: false, saved: false } }));
    } catch {}
  };

  const saveCheckInSettings = async (propertyId) => {
    const cur = checkInSettings[propertyId] || { checkInType: 'front_desk', instructions: '' };
    setCheckInSettings(prev => ({ ...prev, [propertyId]: { ...cur, saving: true, saved: false } }));
    try {
      const res = await authFetch(`${API}/host/property/${propertyId}/access-instructions`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkInType: cur.checkInType, instructions: cur.instructions }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed');
      setCheckInSettings(prev => ({ ...prev, [propertyId]: { ...cur, saving: false, saved: true } }));
      setTimeout(() => setCheckInSettings(prev => ({ ...prev, [propertyId]: { ...prev[propertyId], saved: false } })), 2500);
    } catch (err) {
      alert(err.message || 'Could not save check-in settings');
      setCheckInSettings(prev => ({ ...prev, [propertyId]: { ...cur, saving: false } }));
    }
  };

  // ── Phase 3a: Add Property handlers ─────────────────────────────────────────
  const openAddModal = (mode = 'import') => {
    setEditingId(null);
    setAddMode(mode);
    setImportUrl(''); setImportText(''); setExtractError('');
    setDraft(mode === 'manual' ? blankDraft() : null);
    setBulkBlocks([{ url: '', text: '' }]); setBulkDrafts([]);
    setShowAddModal(true);
  };

  // Reuses the Add Property modal's manual-entry form to edit an existing
  // host-created listing — only ever called for source==='db' cards (the 6
  // fixed catalog properties have no DB row to edit).
  const openEditModal = (p) => {
    setEditingId(p.id);
    setAddMode('manual');
    setDraft({
      title: p.title, description: p.description || '', location: p.location, price: p.price,
      beds: p.beds, baths: p.baths, maxGuests: p.maxGuests, tag: p.tag, images: p.images || [],
      taxRate: p.taxRate, taxJurisdiction: p.taxJurisdiction, sourceUrl: p.sourceUrl || '', importSource: 'manual'
    });
    setShowAddModal(true);
  };

  const handleDeactivate = async (p) => {
    if (!confirm(`Remove "${p.title}" from your listings? This hides it from the dashboard and marketplace — bookings/revenue history for it stays intact.`)) return;
    setDeactivatingId(p.id);
    try {
      const res = await authFetch(`${API}/host/properties/${p.id}/deactivate`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not remove listing');
      refreshProperties();
    } catch (err) {
      alert(err.message || 'Could not remove listing');
    }
    setDeactivatingId(null);
  };

  // Calls the extraction-only endpoint — nothing is written to the DB here.
  // The host always reviews/edits the returned draft (below) before
  // handlePublish actually creates the listing.
  const handleExtract = async () => {
    if (!importText.trim()) { setExtractError('Paste the listing description first'); return; }
    setExtracting(true); setExtractError('');
    try {
      const res = await authFetch(`${API}/host/listings/extract`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: importText, url: importUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not extract listing');
      setDraft({ ...data.draft, images: [], importSource: 'ai-paste' });
    } catch (err) {
      setExtractError(err.message || 'Could not extract listing');
    }
    setExtracting(false);
  };

  // Uploads one photo to Walrus (via /host/listings/photo) and appends the
  // resulting public URL to whichever draft's images array onAdd points at.
  const uploadPhoto = (file, onAdd) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      setUploadingPhoto(true);
      try {
        const res = await authFetch(`${API}/host/listings/photo`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: reader.result })
        });
        const data = await res.json();
        if (res.ok && data.url) onAdd(data.url);
        else alert(data.error || 'Photo upload failed');
      } catch { alert('Photo upload failed'); }
      setUploadingPhoto(false);
    };
    reader.readAsDataURL(file);
  };

  const draftToPayload = (d) => ({
    title: d.title, description: d.description, location: d.location, price: d.price,
    beds: d.beds, baths: d.baths, maxGuests: d.maxGuests, tag: d.tag, images: d.images || [],
    taxRate: d.taxRate, taxJurisdiction: d.taxJurisdiction, sourceUrl: d.sourceUrl || importUrl || null,
    importSource: d.importSource || 'manual'
  });

  // The only route that actually writes a listing to the DB (POST
  // /host/properties) — same validation/clamping whether this draft came from
  // AI extraction or the blank manual-entry form.
  const handlePublish = async () => {
    if (!draft) return;
    if (!draft.title.trim() || !draft.location.trim() || !Number(draft.price)) {
      alert('Title, location, and a price greater than $0 are required');
      return;
    }
    setPublishing(true);
    try {
      const res = await authFetch(editingId ? `${API}/host/properties/${editingId}` : `${API}/host/properties`, {
        method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftToPayload(draft))
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || (editingId ? 'Could not save changes' : 'Could not create listing'));
      setShowAddModal(false);
      setEditingId(null);
      refreshProperties();
    } catch (err) {
      alert(err.message || (editingId ? 'Could not save changes' : 'Could not create listing'));
    }
    setPublishing(false);
  };

  const updateBulkBlock = (i, field, value) =>
    setBulkBlocks(prev => prev.map((b, idx) => idx === i ? { ...b, [field]: value } : b));

  const handleBulkExtract = async () => {
    const valid = bulkBlocks.filter(b => b.text.trim());
    if (!valid.length) return;
    setBulkExtracting(true);
    try {
      const res = await authFetch(`${API}/host/listings/bulk-extract`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listings: valid.map(b => ({ text: b.text, url: b.url })) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk extraction failed');
      setBulkDrafts((data.results || []).map(r => r.error
        ? { error: r.error }
        : { draft: { ...r.draft, images: [], importSource: 'ai-paste' }, publishing: false, published: false }));
    } catch (err) {
      alert(err.message || 'Bulk extraction failed');
    }
    setBulkExtracting(false);
  };

  const updateBulkDraftField = (i, field, value) =>
    setBulkDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, draft: { ...d.draft, [field]: value } } : d));

  const handleBulkPublishOne = async (i) => {
    const item = bulkDrafts[i];
    if (!item?.draft) return;
    setBulkDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, publishing: true } : d));
    try {
      const res = await authFetch(`${API}/host/properties`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftToPayload(item.draft))
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Publish failed');
      setBulkDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, publishing: false, published: true } : d));
      refreshProperties();
    } catch (err) {
      setBulkDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, publishing: false, error: err.message } : d));
    }
  };

  const handleBulkPublishAll = async () => {
    for (let i = 0; i < bulkDrafts.length; i++) {
      if (bulkDrafts[i].draft && !bulkDrafts[i].published) await handleBulkPublishOne(i);
    }
  };

  const loadApplications = async (silent = false) => {
    if (!silent) setApplicationsLoading(true);
    try {
      const res = await authFetch(`${API}/host/applications`);
      const data = await res.json();
      setApplications(data.applications || []);
    } catch {}
    if (!silent) setApplicationsLoading(false);
  };

  useEffect(() => {
    if (activeTab === 'applications') loadApplications();
    if (activeTab === 'tax' && !taxData) loadTaxData();
  }, [activeTab]);

  const handleApprove = async (suiAddress, name) => {
    if (!confirm(`Approve ${name} as a host? They will receive an email and gain access to the Host Dashboard.`)) return;
    setApprovingId(suiAddress);
    try {
      const res = await authFetch(`${API}/host/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suiAddress })
      });
      const data = await res.json();
      if (data.success) {
        await loadApplications();
      } else {
        alert(data.error || 'Failed to approve host');
      }
    } catch { alert('Connection error'); }
    setApprovingId(null);
  };

  const handleRevoke = async (suiAddress, name) => {
    if (!confirm(`Revoke host access for ${name}? They will lose access to the Host Dashboard immediately.`)) return;
    setApprovingId(suiAddress);
    try {
      const res = await authFetch(`${API}/host/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suiAddress })
      });
      const data = await res.json();
      if (data.success) {
        await loadApplications();
      } else {
        alert(data.error || 'Failed to revoke host');
      }
    } catch { alert('Connection error'); }
    setApprovingId(null);
  };

  const loadTaxData = async () => {
    setTaxLoading(true);
    try {
      const res = await authFetch(`${API}/tax/summary`);
      const data = await res.json();
      setTaxData(data);
    } catch {}
    setTaxLoading(false);
  };

  const handleRemit = async () => {
    if (!remitModal) return;
    setRemittingId(remitModal.bookingRef);
    try {
      const res = await authFetch(`${API}/tax/remit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingRef: remitModal.bookingRef, jurisdiction: remitJurisdiction || null, notes: remitNotes || null })
      });
      const data = await res.json();
      if (data.success) { setRemitModal(null); setRemitJurisdiction(''); setRemitNotes(''); await loadTaxData(); }
      else alert(data.error || 'Failed to record remittance');
    } catch { alert('Connection error'); }
    setRemittingId(null);
  };

  const handleUnremit = async (bookingRef) => {
    if (!confirm('Remove remittance record for this booking?')) return;
    try {
      const res = await authFetch(`${API}/tax/unremit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingRef }) });
      const data = await res.json();
      if (data.success) await loadTaxData();
      else alert(data.error || 'Failed');
    } catch { alert('Connection error'); }
  };

  const exportCSV = () => {
    if (!taxData) return;
    const rows = [
      ['Booking Ref', 'Property', 'Guest', 'Check-In', 'Check-Out', 'Nights', 'Subtotal', 'Tax', 'Total', 'Remitted', 'Remitted At', 'Jurisdiction', 'Notes'],
      ...taxData.bookings.map(b => [
        b.bookingRef, b.property, b.guestName,
        fmtDay(b.checkIn), fmtDay(b.checkOut),
        b.nights, `$${b.subtotal}`, `$${b.taxAmount}`, `$${b.totalAmount}`,
        b.remitted ? 'Yes' : 'No', b.remittedAt ? fmtDate(b.remittedAt) : '',
        b.jurisdiction || '', b.notes || ''
      ])
    ];
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `aria-tax-report-${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const copyICal = (propertyId) => {
    navigator.clipboard.writeText(`${API}/ical/${propertyId}`);
    setCopiedId(propertyId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleIcalImport = async (propertyId) => {
    const url = icalInputs[propertyId];
    if (!url) return;
    setIcalSaving(prev => ({ ...prev, [propertyId]: true }));
    const res = await authFetch(`${API}/ical/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId, platform: 'airbnb', icalUrl: url }) });
    const data = await res.json();
    setIcalSaving(prev => ({ ...prev, [propertyId]: false }));
    if (data.success) { setIcalSaved(prev => ({ ...prev, [propertyId]: true })); setTimeout(() => setIcalSaved(prev => ({ ...prev, [propertyId]: false })), 3000); }
  };

  const handleReleaseDeposit = async (bookingRef) => {
    if (!confirm('Release deposit back to guest? This cannot be undone.')) return;
    setReleasingId(bookingRef);
    const res = await authFetch(`${API}/booking/release-deposit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingRef }) });
    const data = await res.json();
    if (data.success) { const bkRes = await authFetch(`${API}/bookings/all`); const bkData = await bkRes.json(); setBookings(bkData.bookings || []); }
    setReleasingId(null);
  };

  // Phase 2h: fetch the guest's encrypted PII pointer, then decrypt client-side
  // via Seal (gated on-chain by escrow.move's seal_approve: only this booking's
  // host, only while the escrow is live). ARIA's backend never sees plaintext.
  const handleViewIdentity = async (b) => {
    setIdentityModal(b);
    setIdentityData(null);
    setIdentityError('');
    setIdentityStatus('loading');
    try {
      const res = await authFetch(`${API}/host/guest-identity/${b.bookingRef}`);
      const meta = await res.json();
      if (!res.ok) throw new Error(meta.error || 'Could not load guest identity');

      const { fetchAndDecryptPII } = await import('../lib/seal');
      const { getZkLoginSuiClient, signPersonalMessageWithZkLogin } = await import('../lib/zklogin');

      setIdentityStatus('signing'); // SessionKey personal-message signature
      const pii = await fetchAndDecryptPII({
        suiClient: getZkLoginSuiClient(),
        blobId: meta.blobId,
        guestAddress: meta.guestAddress,
        escrowObjectId: meta.escrowObjectId,
        hostAddress: user.address,
        signPersonalMessage: signPersonalMessageWithZkLogin,
      });

      setIdentityData(pii);
      setIdentityStatus('done');
    } catch (err) {
      console.error('View guest identity failed:', err);
      setIdentityError(err.message || 'Could not decrypt guest identity');
      setIdentityStatus('error');
    }
  };

  // Finding #9: sum the raw numeric fields (totalAmount/ariaFee/taxes) the
  // API now returns alongside the display strings, instead of regex-parsing
  // breakdown.* — a display-format change could previously have silently
  // corrupted these totals.
  const activeBookings    = bookings.filter(b => b.paymentStatus !== 'cancelled');
  const cancelledBookings = bookings.filter(b => b.paymentStatus === 'cancelled');
  const totalRevenue      = activeBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
  const totalAriaFees     = activeBookings.reduce((sum, b) => sum + (b.ariaFee || 0), 0);
  const totalTaxes        = activeBookings.reduce((sum, b) => sum + (b.taxes || 0), 0);
  const hostEarnings      = totalRevenue - totalAriaFees - totalTaxes;
  const depositsHeld      = activeBookings.filter(b => b.depositAmount && b.depositStatus === 'held').length;
  const totalUnread       = Object.values(messageCounts).reduce((sum, c) => sum + c, 0);
  const avgRating         = reviews.length ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1) : 0;
  const pendingApps       = applications.filter(a => a.status === 'pending').length;

  // Ownership filter (fix for both accounts showing as "owner of all
  // properties"): `properties` above is the full public catalog returned by
  // GET /properties (every fixed demo property plus every host's listings) —
  // it was never filtered down to "properties this logged-in host actually
  // owns." Every render below that represents "your listings" should use
  // myProperties, not properties.
  const myProperties = properties.filter(
    (p) => p.hostAddress && user?.address && normalizeAddr(p.hostAddress) === normalizeAddr(user.address)
  );

  const bookingsByProperty = myProperties.map(p => ({
    ...p,
    bookings: activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)),
    revenue: activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id))
      .reduce((sum, b) => sum + (b.totalAmount || 0), 0)
  }));

  const tabStyle = (tab) => ({
    background: activeTab === tab ? '#ff385c' : 'transparent',
    color: activeTab === tab ? '#fff' : '#717171',
    border: `1px solid ${activeTab === tab ? '#ff385c' : '#ddd'}`,
    padding: '8px 20px', borderRadius: '6px', fontSize: '13px', fontWeight: '600', cursor: 'pointer'
  });

  const stars = (rating) => '⭐'.repeat(rating) + '☆'.repeat(5 - rating);

  const WalrusReceipts = ({ b }) => (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {b.walrusBlobId && <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.walrusBlobId}`} target="_blank" rel="noreferrer" style={{ background: '#eafaf0', border: '1px solid #c8ebd9', color: '#00913f', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>📄 Booking</a>}
      {b.cancellationWalrusBlobId && <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.cancellationWalrusBlobId}`} target="_blank" rel="noreferrer" style={{ background: '#fdeeee', border: '1px solid #f5d0d0', color: '#d23f3f', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>❌ Cancellation</a>}
      {b.depositReleaseWalrusBlobId && <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.depositReleaseWalrusBlobId}`} target="_blank" rel="noreferrer" style={{ background: '#eaf2fc', border: '1px solid #cfe0f5', color: '#1f6fd6', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>🔓 Deposit</a>}
    </div>
  );

  const filteredTaxBookings = taxData?.bookings?.filter(b => {
    if (taxFilter === 'pending') return !b.remitted;
    if (taxFilter === 'remitted') return b.remitted;
    return true;
  }) || [];

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222' }}>Loading host dashboard...</div>;

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#222' }}>
      <style>{`
        .hs-nav-desktop { display: flex; align-items: center; gap: 12px; }
        .hs-nav-hamburger { display: none !important; }
        @media (max-width: 639px) {
          .hs-nav-desktop { display: none !important; }
          .hs-nav-hamburger { display: flex !important; align-items: center; gap: 8px; }
          .hs-stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span onClick={() => router.push('/')} style={{ fontSize: '20px', cursor: 'pointer' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', cursor: 'pointer', color: '#ff385c' }} onClick={() => router.push('/')}>ARIA</span>
          <span style={{ background: '#222', color: '#fff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
          <span style={{ background: '#eaf2fc', border: '1px solid #cfe0f5', color: '#1f6fd6', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>HOST VIEW</span>
        </div>
        {/* Desktop */}
        <div className="hs-nav-desktop">
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500', color: '#222' }}>{user?.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
              <div style={{ fontSize: '11px', color: '#717171', fontFamily: 'monospace', wordBreak: 'break-all' }}>{user?.address}</div>
              <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00913f' : '#999', fontSize: '12px', padding: '0 2px', flexShrink: 0 }}>
                {addrCopied ? '✓' : '⧉'}
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'flex-end', marginTop: '2px' }}>
              <span style={{ fontSize: '11px', color: wallet.lowBalance ? '#d23f3f' : '#717171', fontWeight: '600' }}>
                {wallet.display ?? (wallet.loading ? '···' : '0 SUI')}
              </span>
              <button onClick={wallet.refresh} title="Refresh balance" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '11px', padding: 0 }}>↻</button>
              {wallet.lowBalance && (
                <a href="https://faucet.sui.io/" target="_blank" rel="noreferrer" style={{ color: '#1f6fd6', fontSize: '11px', textDecoration: 'underline' }}>Get testnet SUI</a>
              )}
            </div>
          </div>
          <button onClick={() => router.push('/bookings')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Guest View</button>
          <button onClick={() => router.push('/')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Back to Search</button>
        </div>
        {/* Mobile */}
        <div className="hs-nav-hamburger">
          <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: '3px' }}>
            <span style={{ fontSize: '11px', color: '#717171', fontFamily: 'monospace' }}>{user?.address?.slice(0, 6)}…{user?.address?.slice(-4)}</span>
            <span style={{ color: addrCopied ? '#00913f' : '#999', fontSize: '11px' }}>{addrCopied ? '✓' : '⧉'}</span>
          </button>
          <button onClick={() => setMenuOpen(o => !o)} style={{ background: 'transparent', border: '1px solid #ddd', color: '#222', borderRadius: '6px', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', cursor: 'pointer' }}>
            {menuOpen ? '×' : '☰'}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px', position: 'sticky', top: '60px', zIndex: 99 }}>
          <div style={{ paddingBottom: '8px', borderBottom: '1px solid #ebebeb' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#222' }}>{user?.name}</div>
            <div style={{ fontSize: '11px', color: '#1f6fd6', marginTop: '2px', fontWeight: '700' }}>Host Dashboard</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
              <span style={{ fontSize: '12px', color: wallet.lowBalance ? '#d23f3f' : '#717171', fontWeight: '600' }}>
                💰 {wallet.display ?? (wallet.loading ? '···' : '0 SUI')}
              </span>
              <button onClick={wallet.refresh} title="Refresh balance" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '12px', padding: 0 }}>↻</button>
              {wallet.lowBalance && (
                <a href="https://faucet.sui.io/" target="_blank" rel="noreferrer" style={{ color: '#1f6fd6', fontSize: '12px', textDecoration: 'underline' }}>Get testnet SUI</a>
              )}
            </div>
          </div>
          {[
            { label: '👤 Guest View', path: '/bookings' },
            { label: '🏠 Back to Search', path: '/' },
          ].map((item, i) => (
            <button key={i} onClick={() => { router.push(item.path); setMenuOpen(false); }} style={{ background: '#f7f7f7', border: '1px solid #ebebeb', color: '#222', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', textAlign: 'left', cursor: 'pointer' }}>
              {item.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '40px 24px' }}>
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '700', margin: '0 0 4px', color: '#222' }}>Host Dashboard</h1>
          <p style={{ color: '#717171', fontSize: '14px', margin: 0 }}>Manage your listings, bookings, and payouts</p>
        </div>

        {/* Stats */}
        <div className="hs-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '16px', marginBottom: '32px' }}>
          {[
            { label: 'TOTAL BOOKINGS', value: activeBookings.length, color: '#00913f', sub: `${cancelledBookings.length} cancelled` },
            { label: 'GROSS REVENUE', value: `$${totalRevenue.toLocaleString()}`, color: '#00913f', sub: 'SuiUSD + card' },
            { label: 'ARIA FEES (5%)', value: `$${totalAriaFees.toLocaleString()}`, color: '#d23f3f', sub: 'vs 15% Airbnb' },
            { label: 'YOUR EARNINGS', value: `$${hostEarnings.toLocaleString()}`, color: '#1f6fd6', sub: 'net payout' },
            { label: 'ACTIVE LISTINGS', value: myProperties.length, color: '#00913f', sub: 'properties' },
            { label: 'TAXES COLLECTED', value: `$${totalTaxes.toLocaleString()}`, color: '#a66a00', sub: 'occupancy tax, varies by jurisdiction' },
            { label: 'DEPOSITS HELD', value: depositsHeld, color: '#1f6fd6', sub: 'in Sui escrow' },
            { label: 'MESSAGES', value: totalUnread, color: totalUnread > 0 ? '#d23f3f' : '#999', sub: totalUnread > 0 ? 'need attention' : 'all caught up' },
            { label: 'AVG RATING', value: avgRating > 0 ? `${avgRating} ⭐` : '—', color: '#a66a00', sub: `${reviews.length} review${reviews.length !== 1 ? 's' : ''}` },
          ].map((s, i) => (
            <div key={i} style={{ background: '#fff', border: `1px solid ${i === 7 && totalUnread > 0 ? '#f5d0d0' : '#ebebeb'}`, borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              <div style={{ fontSize: '10px', color: '#999', marginBottom: '8px', fontWeight: '600' }}>{s.label}</div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: s.color, marginBottom: '4px' }}>{s.value}</div>
              <div style={{ fontSize: '11px', color: '#999' }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
          {['overview', 'bookings', 'listings', 'calendar', 'reviews', 'tax', 'applications'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={tabStyle(tab)}>
              {tab === 'overview'      ? '📊 Overview' :
               tab === 'bookings'     ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>📋 Bookings {totalUnread > 0 && <span style={{ background: '#d23f3f', color: '#fff', borderRadius: '50%', fontSize: '10px', fontWeight: '700', padding: '1px 5px' }}>{totalUnread}</span>}</span> :
               tab === 'listings'     ? '🏠 Listings' :
               tab === 'calendar'     ? '📅 Calendar Sync' :
               tab === 'reviews'      ? '⭐ Reviews' :
               tab === 'tax'          ? '💰 Tax' :
               <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>👥 Applications {pendingApps > 0 && <span style={{ background: '#a66a00', color: '#fff', borderRadius: '50%', fontSize: '10px', fontWeight: '700', padding: '1px 5px' }}>{pendingApps}</span>}</span>}
            </button>
          ))}
        </div>

        {/* Overview */}
        {activeTab === 'overview' && (
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 16px', color: '#222' }}>Revenue by Property</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {bookingsByProperty.map(p => (
                <div key={p.id} style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '12px', padding: '16px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                  <img src={p.image} alt={p.title} style={{ width: '60px', height: '60px', objectFit: 'cover', borderRadius: '8px' }} />
                  <div style={{ flex: 1, minWidth: '150px' }}>
                    <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '2px', color: '#222' }}>{p.title}</div>
                    <div style={{ fontSize: '12px', color: '#717171' }}>{p.location}</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: '80px' }}>
                    <div style={{ fontSize: '20px', fontWeight: '700', color: '#00913f' }}>{p.bookings.length}</div>
                    <div style={{ fontSize: '10px', color: '#999' }}>BOOKINGS</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: '100px' }}>
                    <div style={{ fontSize: '20px', fontWeight: '700', color: '#1f6fd6' }}>${p.revenue.toLocaleString()}</div>
                    <div style={{ fontSize: '10px', color: '#999' }}>REVENUE</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: '80px' }}>
                    <div style={{ fontSize: '16px', fontWeight: '700', color: '#717171' }}>${p.price}</div>
                    <div style={{ fontSize: '10px', color: '#999' }}>PER NIGHT</div>
                  </div>
                  {p.bookings.length > 0 && <div style={{ background: '#eafaf0', border: '1px solid #c8ebd9', borderRadius: '6px', padding: '4px 10px' }}><span style={{ fontSize: '11px', color: '#00913f', fontWeight: '600' }}>● Active</span></div>}
                </div>
              ))}
            </div>
            <div style={{ background: '#eaf2fc', border: '1px solid #cfe0f5', borderRadius: '12px', padding: '20px', marginTop: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <span style={{ fontSize: '16px' }}>⚡</span>
                <span style={{ fontWeight: '600', fontSize: '15px', color: '#222' }}>DeepBook Settlement</span>
                <span style={{ background: '#fff', border: '1px solid #cfe0f5', color: '#1f6fd6', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px' }}>LIVE</span>
              </div>
              <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 12px', lineHeight: '1.6' }}>Host payouts settle instantly via DeepBook on Sui. No 3–5 day bank delays.</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
                {[['Settlement Time','< 1 second','#00913f'],['Airbnb Payout Delay','3–5 days','#d23f3f'],['Your Net Rate','95% of booking','#1f6fd6'],['Airbnb Net Rate','85% of booking','#d23f3f']].map(([label, val, color], i) => (
                  <div key={i} style={{ background: '#fff', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#999', marginBottom: '4px' }}>{label}</div>
                    <div style={{ fontSize: '16px', fontWeight: '700', color }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Bookings */}
        {activeTab === 'bookings' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0, color: '#222' }}>All Bookings</h3>
              <span style={{ fontSize: '13px', color: '#717171' }}>{bookings.length} total</span>
            </div>
            {bookings.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 24px', background: '#f7f7f7', borderRadius: '12px', border: '1px solid #ebebeb' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>📋</div>
                <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px', color: '#222' }}>No bookings yet</h3>
                <p style={{ color: '#717171', fontSize: '14px', margin: 0 }}>Bookings will appear here once guests start booking</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {bookings.map((b, i) => (
                  <div key={i} style={{ background: '#fff', border: `1px solid ${b.paymentStatus === 'cancelled' ? '#f5d0d0' : '#ebebeb'}`, borderRadius: '12px', padding: '20px', opacity: b.paymentStatus === 'cancelled' ? 0.75 : 1, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                      <div>
                        <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '4px', color: '#222' }}>{b.property}</div>
                        <div style={{ fontSize: '12px', color: '#717171', marginBottom: '6px' }}>{b.guestName || 'Guest'} · {b.guestEmail || ''}</div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ background: b.paymentStatus === 'cancelled' ? '#fdeeee' : '#eafaf0', border: `1px solid ${b.paymentStatus === 'cancelled' ? '#f5d0d0' : '#c8ebd9'}`, color: b.paymentStatus === 'cancelled' ? '#d23f3f' : '#00913f', fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px' }}>
                            {b.paymentStatus === 'cancelled' ? '✕ cancelled' : '✅ confirmed'}
                          </span>
                          {b.depositAmount && b.paymentStatus !== 'cancelled' && (
                            // Same fix as pages/bookings.jsx: branch on the real
                            // depositStatus instead of just "!= released", so a
                            // never-verified escrow (depositStatus still 'pending')
                            // doesn't get shown to the host as funds already held.
                            <span style={{ background: b.depositStatus === 'released' ? '#eafaf0' : b.depositStatus === 'held' ? '#eaf2fc' : '#fff8e1', border: `1px solid ${b.depositStatus === 'released' ? '#c8ebd9' : b.depositStatus === 'held' ? '#cfe0f5' : '#ffe7a0'}`, color: b.depositStatus === 'released' ? '#00913f' : b.depositStatus === 'held' ? '#1f6fd6' : '#a66a00', fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px' }}>
                              {b.depositStatus === 'released' ? '🔓 Deposit released' : b.depositStatus === 'held' ? `🔒 Deposit $${b.depositAmount} held` : '⏳ Deposit not yet confirmed'}
                            </span>
                          )}
                          {b.checkedIn && (
                            <span style={{ background: '#eafaf0', border: '1px solid #c8ebd9', color: '#00913f', fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px' }}>
                              ✅ Checked In{b.checkedInAt ? ` · ${new Date(b.checkedInAt).toLocaleTimeString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '18px', fontWeight: '700', color: b.paymentStatus === 'cancelled' ? '#999' : '#00913f', textDecoration: b.paymentStatus === 'cancelled' ? 'line-through' : 'none' }}>{b.breakdown?.totalPaid || `$${b.totalAmount}`}</div>
                        <div style={{ fontSize: '11px', color: '#999' }}>{fmtDay(b.checkIn)} → {fmtDay(b.checkOut)}</div>
                        <div style={{ fontSize: '11px', color: '#999' }}>{b.nights} night{b.nights > 1 ? 's' : ''}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ fontSize: '11px', color: '#999', fontFamily: 'monospace' }}>Ref: {b.bookingRef}</div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <WalrusReceipts b={b} />
                        {b.paymentStatus !== 'cancelled' && (
                          <button onClick={() => router.push(`/messages?bookingRef=${b.bookingRef}&property=${encodeURIComponent(b.property)}`)}
                            style={{ background: messageCounts[b.bookingRef] > 0 ? '#fdeeee' : 'transparent', border: `1px solid ${messageCounts[b.bookingRef] > 0 ? '#f5d0d0' : '#cfe0f5'}`, color: '#1f6fd6', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            💬 Messages {messageCounts[b.bookingRef] > 0 && <span style={{ background: '#d23f3f', color: '#fff', borderRadius: '50%', fontSize: '10px', fontWeight: '700', padding: '1px 5px' }}>{messageCounts[b.bookingRef]}</span>}
                          </button>
                        )}
                        {/* Was "!== 'released'", which also matched 'pending' —
                            letting hosts try to release a deposit that was never
                            actually verified/held on-chain. autoReleaseEscrow
                            already no-ops safely without an escrow_object_id, but
                            showing the button at all was misleading. */}
                        {b.depositAmount && b.depositStatus === 'held' && (
                          <button onClick={() => handleReleaseDeposit(b.bookingRef)} disabled={releasingId === b.bookingRef}
                            style={{ background: '#eaf2fc', border: '1px solid #cfe0f5', color: releasingId === b.bookingRef ? '#999' : '#1f6fd6', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: releasingId === b.bookingRef ? 'not-allowed' : 'pointer', fontWeight: '600' }}>
                            {releasingId === b.bookingRef ? 'Releasing...' : '🔓 Release Deposit'}
                          </button>
                        )}
                        {b.paymentStatus !== 'cancelled' && (
                          <button onClick={() => handleViewIdentity(b)}
                            style={{ background: 'transparent', border: '1px solid #e0c8fa', color: '#8b3dff', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
                            🪪 View Guest Identity
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Listings */}
        {activeTab === 'listings' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0, color: '#222' }}>Your Listings</h3>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => openAddModal('import')} style={{ background: '#ff385c', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 16px', fontSize: '12px', fontWeight: '700', cursor: 'pointer' }}>
                  + Add Property
                </button>
                <button onClick={() => openAddModal('bulk')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '6px', padding: '8px 16px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>
                  Bulk Import
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
              {myProperties.map(p => (
                <div key={p.id} style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                  <div style={{ height: '160px', overflow: 'hidden', position: 'relative' }}>
                    <img src={p.image} alt={p.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <span style={{ position: 'absolute', top: '10px', left: '10px', background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: '11px', fontWeight: '600', padding: '3px 8px', borderRadius: '6px' }}>{p.tag}</span>
                    <span style={{ position: 'absolute', top: '10px', right: '10px', background: '#eafaf0', border: '1px solid #c8ebd9', color: '#00913f', fontSize: '11px', fontWeight: '600', padding: '3px 8px', borderRadius: '6px' }}>● Listed</span>
                  </div>
                  <div style={{ padding: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <h4 style={{ margin: 0, fontSize: '15px', fontWeight: '600', color: '#222' }}>{p.title}</h4>
                      <span style={{ fontSize: '15px', fontWeight: '700', color: '#00913f' }}>${p.price}<span style={{ fontSize: '11px', color: '#999' }}>/night</span></span>
                    </div>
                    <p style={{ color: '#717171', fontSize: '12px', margin: '0 0 12px' }}>{p.location} · {p.beds} beds · {p.baths} baths</p>
                    {/* Edit/Remove only apply to host-created listings (a DB
                        row to act on) — the 6 fixed catalog demo properties
                        are code constants with no row behind them. */}
                    {p.source === 'db' && (
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                        <button onClick={() => openEditModal(p)}
                          style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '6px', padding: '6px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}>
                          ✏️ Edit Listing
                        </button>
                        <button onClick={() => handleDeactivate(p)} disabled={deactivatingId === p.id}
                          style={{ flex: 1, background: 'transparent', border: '1px solid #f5d0d0', color: deactivatingId === p.id ? '#999' : '#d23f3f', borderRadius: '6px', padding: '6px', fontSize: '11px', fontWeight: '600', cursor: deactivatingId === p.id ? 'wait' : 'pointer' }}>
                          {deactivatingId === p.id ? 'Removing...' : '🗑️ Remove'}
                        </button>
                      </div>
                    )}
                    <div style={{ background: '#f7f7f7', borderRadius: '8px', padding: '10px', marginBottom: '10px' }}>
                      <div style={{ fontSize: '10px', color: '#999', marginBottom: '6px', fontWeight: '600' }}>ICAL EXPORT</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <div style={{ flex: 1, background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', color: '#717171', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{API}/ical/{p.id}</div>
                        <button onClick={() => copyICal(p.id)} style={{ background: copiedId === p.id ? '#eafaf0' : '#fff', border: `1px solid ${copiedId === p.id ? '#00913f' : '#ddd'}`, color: copiedId === p.id ? '#00913f' : '#717171', fontSize: '11px', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', whiteSpace: 'nowrap' }}>
                          {copiedId === p.id ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    {/* Phase 2c: resale transferability (Rail 1 opt-in + Rail 2 cap) */}
                    {(() => {
                      const rs = resaleSettings[p.id] || { transferAllowed: false, maxPremiumBps: 0 };
                      const saving = !!savingResale[p.id];
                      return (
                        <div style={{ background: '#fff8e1', border: '1px solid #ffe7a0', borderRadius: '8px', padding: '10px', marginBottom: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ fontSize: '10px', color: '#a66a00', fontWeight: '700' }}>🏷️ GUEST RESALE</div>
                            <button onClick={() => saveResaleSettings(p.id, { transferAllowed: !rs.transferAllowed })} disabled={saving}
                              style={{ background: rs.transferAllowed ? '#ffe7a0' : '#fff', border: `1px solid ${rs.transferAllowed ? '#a66a00' : '#ddd'}`, color: rs.transferAllowed ? '#a66a00' : '#717171', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: saving ? 'wait' : 'pointer', fontWeight: '600' }}>
                              {rs.transferAllowed ? '● On' : '○ Off'}
                            </button>
                          </div>
                          {rs.transferAllowed && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
                              <span style={{ fontSize: '11px', color: '#717171' }}>Max markup</span>
                              <select value={rs.maxPremiumBps} onChange={e => saveResaleSettings(p.id, { maxPremiumBps: Number(e.target.value) })} disabled={saving}
                                style={{ flex: 1, background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '5px 8px', fontSize: '11px', color: '#222', outline: 'none' }}>
                                <option value={0}>Face value only (0%)</option>
                                <option value={1000}>+10%</option>
                                <option value={2500}>+25%</option>
                                <option value={5000}>+50%</option>
                                <option value={10000}>+100%</option>
                              </select>
                            </div>
                          )}
                          <p style={{ color: '#a66a00', fontSize: '10px', margin: '8px 0 0', lineHeight: 1.5 }}>
                            {resaleEnabled ? 'Applies to future bookings. Any markup splits ARIA 10% / you 45% / seller 45%.' : 'Resale is globally disabled until launch — this just stages your preference.'}
                          </p>
                        </div>
                      );
                    })()}
                    {/* P4: self check-in settings — all listed properties */}
                    {(() => {
                      const ci = checkInSettings[p.id];
                      // Lazy-load on first render of this card
                      if (!ci) { loadCheckInSettings(p.id); return null; }
                      const isSelf = ci.checkInType === 'self';
                      return (
                        <div style={{ background: '#f0f7ff', border: '1px solid #c8dff7', borderRadius: '8px', padding: '10px', marginBottom: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ fontSize: '10px', color: '#1f6fd6', fontWeight: '700' }}>🔑 CHECK-IN TYPE</div>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button onClick={() => setCheckInSettings(prev => ({ ...prev, [p.id]: { ...prev[p.id], checkInType: 'front_desk' } }))}
                                style={{ background: !isSelf ? '#1f6fd6' : '#fff', color: !isSelf ? '#fff' : '#717171', border: '1px solid #c8dff7', borderRadius: '6px', fontSize: '11px', padding: '3px 10px', cursor: 'pointer', fontWeight: !isSelf ? '700' : '400' }}>
                                Front Desk
                              </button>
                              <button onClick={() => setCheckInSettings(prev => ({ ...prev, [p.id]: { ...prev[p.id], checkInType: 'self' } }))}
                                style={{ background: isSelf ? '#1f6fd6' : '#fff', color: isSelf ? '#fff' : '#717171', border: '1px solid #c8dff7', borderRadius: '6px', fontSize: '11px', padding: '3px 10px', cursor: 'pointer', fontWeight: isSelf ? '700' : '400' }}>
                                Self Check-in
                              </button>
                            </div>
                          </div>
                          {isSelf && (
                            <>
                              <textarea
                                placeholder={'Door code: 1234\nLockbox: left side of garage\nWifi: NetworkName / password123\nParking: spot 4B behind building'}
                                value={ci.instructions}
                                onChange={e => setCheckInSettings(prev => ({ ...prev, [p.id]: { ...prev[p.id], instructions: e.target.value } }))}
                                rows={4}
                                style={{ width: '100%', marginTop: '10px', background: '#fff', border: '1px solid #c8dff7', borderRadius: '6px', padding: '8px 10px', fontSize: '12px', color: '#222', outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5 }}
                              />
                              <p style={{ color: '#717171', fontSize: '10px', margin: '4px 0 8px', lineHeight: 1.4 }}>
                                Encrypted before saving. Only revealed to the confirmed guest within 2 hours of their check-in date.
                              </p>
                            </>
                          )}
                          <button onClick={() => saveCheckInSettings(p.id)} disabled={ci.saving}
                            style={{ marginTop: isSelf ? 0 : '8px', background: ci.saved ? '#eafaf0' : '#1f6fd6', color: ci.saved ? '#00913f' : '#fff', border: 'none', borderRadius: '6px', padding: '5px 14px', fontSize: '11px', fontWeight: '600', cursor: ci.saving ? 'wait' : 'pointer' }}>
                            {ci.saving ? 'Saving…' : ci.saved ? '✓ Saved' : 'Save'}
                          </button>
                        </div>
                      );
                    })()}
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {[['BOOKINGS', activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)).length, '#00913f'],
                        ['REVENUE', `$${activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)).reduce((s, b) => s + (b.totalAmount || 0), 0).toLocaleString()}`, '#1f6fd6'],
                        ['ARIA FEE', '5%', '#00913f']].map(([label, val, color]) => (
                        <div key={label} style={{ flex: 1, background: '#f7f7f7', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                          <div style={{ fontSize: '10px', color: '#999', marginBottom: '2px' }}>{label}</div>
                          <div style={{ fontWeight: '700', color }}>{val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Calendar */}
        {activeTab === 'calendar' && (
          <div>
            <div style={{ background: '#eaf2fc', border: '1px solid #cfe0f5', borderRadius: '12px', padding: '20px', marginBottom: '24px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 8px', color: '#222' }}>📅 Two-Way Calendar Sync</h3>
              <p style={{ color: '#717171', fontSize: '13px', margin: 0, lineHeight: '1.6' }}>Export your ARIA calendar to Airbnb/VRBO, and import their calendars here.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {myProperties.map(p => (
                <div key={p.id} style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                    <img src={p.image} alt={p.title} style={{ width: '48px', height: '48px', objectFit: 'cover', borderRadius: '8px' }} />
                    <div><div style={{ fontSize: '15px', fontWeight: '600', color: '#222' }}>{p.title}</div><div style={{ fontSize: '12px', color: '#717171' }}>{p.location}</div></div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ background: '#f7f7f7', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#00913f', fontWeight: '600', marginBottom: '6px' }}>↑ EXPORT</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <div style={{ flex: 1, background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '6px 8px', fontSize: '10px', color: '#717171', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{API}/ical/{p.id}</div>
                        <button onClick={() => copyICal(p.id)} style={{ background: copiedId === p.id ? '#eafaf0' : '#fff', border: `1px solid ${copiedId === p.id ? '#00913f' : '#ddd'}`, color: copiedId === p.id ? '#00913f' : '#717171', fontSize: '11px', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>{copiedId === p.id ? '✓' : 'Copy'}</button>
                      </div>
                    </div>
                    <div style={{ background: '#f7f7f7', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#1f6fd6', fontWeight: '600', marginBottom: '6px' }}>↓ IMPORT</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input value={icalInputs[p.id] || ''} onChange={e => setIcalInputs(prev => ({ ...prev, [p.id]: e.target.value }))} placeholder="https://airbnb.com/calendar/ical/..." style={{ flex: 1, background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '6px 8px', fontSize: '10px', color: '#222', outline: 'none' }} />
                        <button onClick={() => handleIcalImport(p.id)} disabled={icalSaving[p.id] || !icalInputs[p.id]} style={{ background: icalSaved[p.id] ? '#eafaf0' : '#fff', border: `1px solid ${icalSaved[p.id] ? '#00913f' : '#ddd'}`, color: icalSaved[p.id] ? '#00913f' : '#717171', fontSize: '11px', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>{icalSaving[p.id] ? '...' : icalSaved[p.id] ? '✓' : 'Sync'}</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reviews */}
        {activeTab === 'reviews' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0, color: '#222' }}>Guest Reviews</h3>
              <span style={{ fontSize: '13px', color: '#717171' }}>{reviews.length} total · avg {avgRating} ⭐</span>
            </div>
            {reviews.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 24px', background: '#f7f7f7', borderRadius: '12px', border: '1px solid #ebebeb' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>⭐</div>
                <p style={{ color: '#717171', fontSize: '14px', margin: 0 }}>Guest reviews will appear here after their stay</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {reviews.map((r, i) => {
                  const prop = properties.find(p => p.id === r.propertyId || String(p.id) === String(r.propertyId));
                  return (
                    <div key={i} style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                        <div>
                          <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: '#222' }}>
                            {prop?.title || `Property ${r.propertyId}`}
                            {r.verified && (
                              <span title="Backed by a real on-chain escrow booking" style={{ background: '#eafaf0', border: '1px solid #c8ebd9', color: '#00913f', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '20px' }}>
                                ✓ Verified stay
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '12px', color: '#717171' }}>{r.guestName} · {fmtDate(r.timestamp)}</div>
                        </div>
                        <div style={{ fontSize: '20px' }}>{stars(r.rating)}</div>
                      </div>
                      <p style={{ color: '#222', fontSize: '14px', margin: '0 0 8px', lineHeight: '1.6' }}>{r.review}</p>
                      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', fontSize: '11px', color: '#999', fontFamily: 'monospace' }}>
                        <span>Ref: {r.bookingRef}</span>
                        {r.walrusBlobId && (
                          <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${r.walrusBlobId}`} target="_blank" rel="noreferrer"
                            style={{ color: '#00913f', textDecoration: 'none' }}>🔗 on-chain proof</a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tax */}
        {activeTab === 'tax' && (
          <div>
            <div style={{ background: '#fff8e1', border: '1px solid #ffe7a0', borderRadius: '12px', padding: '16px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '16px' }}>⚖️</span>
                <span style={{ fontWeight: '600', fontSize: '14px', color: '#a66a00' }}>Occupancy Tax Compliance</span>
              </div>
              <p style={{ color: '#7a6228', fontSize: '12px', margin: 0, lineHeight: '1.6' }}>ARIA collects occupancy tax on every booking at the rate set by each property's jurisdiction (rates vary, typically 8–17%). As the host, you are responsible for remitting these taxes to the appropriate local jurisdiction.</p>
            </div>
            {taxLoading ? (
              <div style={{ textAlign: 'center', padding: '60px', color: '#999' }}>Loading tax data...</div>
            ) : !taxData ? (
              <div style={{ textAlign: 'center', padding: '60px' }}>
                <button onClick={loadTaxData} style={{ background: '#ff385c', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px 24px', fontWeight: '700', cursor: 'pointer' }}>Load Tax Data</button>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' }}>
                  {[
                    { label: 'TOTAL COLLECTED', value: `$${taxData.summary.totalCollected.toLocaleString()}`, color: '#a66a00', sub: `${taxData.summary.bookingCount} bookings` },
                    { label: 'REMITTED', value: `$${taxData.summary.totalRemitted.toLocaleString()}`, color: '#00913f', sub: `${taxData.summary.remittedCount} bookings` },
                    { label: 'OUTSTANDING', value: `$${taxData.summary.totalOutstanding.toLocaleString()}`, color: taxData.summary.totalOutstanding > 0 ? '#d23f3f' : '#999', sub: `${taxData.summary.pendingCount} pending` },
                    { label: 'TAX RATE', value: 'Varies', color: '#717171', sub: 'set per jurisdiction' },
                  ].map((s, i) => (
                    <div key={i} style={{ background: '#fff', border: `1px solid ${i === 2 && taxData.summary.totalOutstanding > 0 ? '#f5d0d0' : '#ebebeb'}`, borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                      <div style={{ fontSize: '10px', color: '#999', marginBottom: '8px', fontWeight: '600' }}>{s.label}</div>
                      <div style={{ fontSize: '24px', fontWeight: '700', color: s.color, marginBottom: '4px' }}>{s.value}</div>
                      <div style={{ fontSize: '11px', color: '#999' }}>{s.sub}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {['all', 'pending', 'remitted'].map(f => (
                      <button key={f} onClick={() => setTaxFilter(f)}
                        style={{ background: taxFilter === f ? '#a66a00' : 'transparent', color: taxFilter === f ? '#fff' : '#717171', border: `1px solid ${taxFilter === f ? '#a66a00' : '#ddd'}`, padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>
                        {f === 'all' ? `All (${taxData.summary.bookingCount})` : f === 'pending' ? `Pending (${taxData.summary.pendingCount})` : `Remitted (${taxData.summary.remittedCount})`}
                      </button>
                    ))}
                  </div>
                  <button onClick={exportCSV} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>⬇ Export CSV</button>
                </div>
                {filteredTaxBookings.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px', background: '#f7f7f7', borderRadius: '12px', border: '1px solid #ebebeb', color: '#999' }}>No bookings in this category</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {filteredTaxBookings.map((b, i) => (
                      <div key={i} style={{ background: '#fff', border: `1px solid ${b.remitted ? '#c8ebd9' : '#ffe7a0'}`, borderRadius: '12px', padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: '8px' }}>
                          <div style={{ flex: 1, minWidth: '200px' }}>
                            <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '2px', color: '#222' }}>{b.property}</div>
                            <div style={{ fontSize: '12px', color: '#717171', marginBottom: '4px' }}>{b.guestName} · {fmtDay(b.checkIn)} → {fmtDay(b.checkOut)} · {b.nights} night{b.nights > 1 ? 's' : ''}</div>
                            <div style={{ fontSize: '11px', color: '#999', fontFamily: 'monospace' }}>{b.bookingRef}</div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '10px', color: '#999', marginBottom: '2px' }}>SUBTOTAL</div>
                              <div style={{ fontSize: '14px', fontWeight: '600', color: '#222' }}>${b.subtotal}</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '10px', color: '#999', marginBottom: '2px' }}>
                                TAX{b.subtotal > 0 ? ` (${Math.round((b.taxAmount / b.subtotal) * 100)}%)` : ''}
                              </div>
                              <div style={{ fontSize: '16px', fontWeight: '700', color: '#a66a00' }}>${b.taxAmount}</div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                              {b.remitted ? (
                                <>
                                  <span style={{ background: '#eafaf0', border: '1px solid #c8ebd9', color: '#00913f', fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '20px' }}>✅ Remitted {b.remittedAt ? fmtDate(b.remittedAt) : ''}</span>
                                  {b.jurisdiction && <span style={{ fontSize: '11px', color: '#999' }}>{b.jurisdiction}</span>}
                                  <button onClick={() => handleUnremit(b.bookingRef)} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', fontSize: '10px', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer' }}>Undo</button>
                                </>
                              ) : (
                                <button onClick={() => { setRemitModal(b); setRemitJurisdiction(''); setRemitNotes(''); }}
                                  style={{ background: '#a66a00', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', fontSize: '12px', fontWeight: '700', cursor: 'pointer' }}>
                                  Mark Remitted
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Applications */}
        {activeTab === 'applications' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0, color: '#222' }}>Host Applications</h3>
              <button onClick={() => loadApplications()} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>↻ Refresh</button>
            </div>

            {applicationsLoading ? (
              <div style={{ textAlign: 'center', padding: '60px', color: '#999' }}>Loading applications...</div>
            ) : applications.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 24px', background: '#f7f7f7', borderRadius: '12px', border: '1px solid #ebebeb' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>👥</div>
                <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px', color: '#222' }}>No applications yet</h3>
                <p style={{ color: '#717171', fontSize: '14px', margin: 0 }}>Host applications will appear here when users sign up</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', gap: '12px', marginBottom: '8px' }}>
                  {[
                    { label: 'TOTAL', value: applications.length, color: '#717171' },
                    { label: 'PENDING', value: applications.filter(a => a.status === 'pending').length, color: '#a66a00' },
                    { label: 'APPROVED', value: applications.filter(a => a.status === 'approved').length, color: '#00913f' },
                    { label: 'REVOKED', value: applications.filter(a => a.status === 'revoked').length, color: '#b3261e' },
                  ].map((s, i) => (
                    <div key={i} style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '8px', padding: '12px 20px', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                      <div style={{ fontSize: '10px', color: '#999', marginBottom: '4px', fontWeight: '600' }}>{s.label}</div>
                      <div style={{ fontSize: '20px', fontWeight: '700', color: s.color }}>{s.value}</div>
                    </div>
                  ))}
                </div>

                {applications.map((a, i) => {
                  const badgeColors = {
                    pending:  { bg: '#fff8e1', border: '#ffe7a0', text: '#a66a00', label: '⏳ Pending' },
                    approved: { bg: '#eafaf0', border: '#c8ebd9', text: '#00913f', label: '✅ Approved' },
                    revoked:  { bg: '#fbeaea', border: '#f0c6c6', text: '#b3261e', label: '🚫 Revoked' },
                  };
                  const badge = badgeColors[a.status] || badgeColors.approved;
                  return (
                  <div key={i} style={{ background: '#fff', border: `1px solid ${badge.border}`, borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: '12px' }}>
                      <div style={{ flex: 1, minWidth: '200px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                          <div style={{ fontSize: '15px', fontWeight: '600', color: '#222' }}>{a.name}</div>
                          <span style={{
                            background: badge.bg, border: `1px solid ${badge.border}`, color: badge.text,
                            fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px'
                          }}>
                            {badge.label}
                          </span>
                        </div>
                        <div style={{ fontSize: '13px', color: '#717171', marginBottom: '4px' }}>{a.email}</div>
                        {a.city && <div style={{ fontSize: '12px', color: '#717171', marginBottom: '4px' }}>📍 {a.city}{a.state ? ', ' + a.state : ''}{a.jurisdiction ? ` · ${a.jurisdiction}` : ''}</div>}
                        {a.str_permit && <div style={{ fontSize: '12px', color: '#717171', marginBottom: '4px' }}>🪪 STR Permit: {a.str_permit}</div>}
                        <div style={{ fontSize: '11px', color: '#999', fontFamily: 'monospace', marginTop: '4px' }}>{a.sui_address}</div>
                        <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>Applied {fmtDateTime(a.created_at)}</div>
                        {a.approved_at && <div style={{ fontSize: '11px', color: '#00913f', marginTop: '2px' }}>Approved {fmtDateTime(a.approved_at)}</div>}
                      </div>

                      {(a.status === 'pending' || a.status === 'revoked') && (
                        <button onClick={() => handleApprove(a.sui_address, a.name)} disabled={approvingId === a.sui_address}
                          style={{ background: approvingId === a.sui_address ? '#eee' : '#00913f', color: approvingId === a.sui_address ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '10px 20px', fontSize: '13px', fontWeight: '700', cursor: approvingId === a.sui_address ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                          {approvingId === a.sui_address ? 'Approving...' : (a.status === 'revoked' ? '✅ Re-approve Host' : '✅ Approve Host')}
                        </button>
                      )}
                      {a.status === 'approved' && (
                        <button onClick={() => handleRevoke(a.sui_address, a.name)} disabled={approvingId === a.sui_address}
                          style={{ background: approvingId === a.sui_address ? '#eee' : '#fff', color: approvingId === a.sui_address ? '#999' : '#b3261e', border: `1px solid ${approvingId === a.sui_address ? '#eee' : '#f0c6c6'}`, borderRadius: '8px', padding: '10px 20px', fontSize: '13px', fontWeight: '700', cursor: approvingId === a.sui_address ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                          {approvingId === a.sui_address ? 'Revoking...' : '🚫 Revoke Host'}
                        </button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

      </div>

      {/* Remit Modal */}
      {remitModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '480px', padding: '32px', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: '700', color: '#222' }}>Mark Tax as Remitted</h3>
            <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 20px' }}>{remitModal.property} · {fmtDay(remitModal.checkIn)}</p>
            <div style={{ background: '#fff8e1', border: '1px solid #ffe7a0', borderRadius: '8px', padding: '12px', marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ color: '#717171', fontSize: '13px' }}>Subtotal</span>
                <span style={{ fontSize: '13px', color: '#222' }}>${remitModal.subtotal}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#a66a00', fontSize: '14px', fontWeight: '600' }}>
                  Occupancy Tax{remitModal.subtotal > 0 ? ` (${Math.round((remitModal.taxAmount / remitModal.subtotal) * 100)}%)` : ''}
                </span>
                <span style={{ color: '#a66a00', fontSize: '16px', fontWeight: '700' }}>${remitModal.taxAmount}</span>
              </div>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', color: '#717171', marginBottom: '6px', fontWeight: '600' }}>JURISDICTION (optional)</div>
              <input value={remitJurisdiction} onChange={e => setRemitJurisdiction(e.target.value)} placeholder="e.g. Miami-Dade County, FL"
                style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '12px', color: '#717171', marginBottom: '6px', fontWeight: '600' }}>NOTES (optional)</div>
              <input value={remitNotes} onChange={e => setRemitNotes(e.target.value)} placeholder="e.g. Confirmation #12345"
                style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setRemitModal(null)} style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '12px', fontSize: '14px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleRemit} disabled={!!remittingId}
                style={{ flex: 2, background: remittingId ? '#eee' : '#a66a00', color: remittingId ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: remittingId ? 'not-allowed' : 'pointer' }}>
                {remittingId ? 'Recording...' : `Confirm Remittance — $${remitModal.taxAmount}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 2h: Guest Identity (Seal decrypt) Modal */}
      {identityModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '460px', padding: '28px', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '19px', fontWeight: '700', color: '#222' }}>🪪 Guest Identity</h3>
            <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 18px' }}>
              {identityModal.guestName || 'Guest'} · Ref {identityModal.bookingRef}
            </p>

            {identityStatus !== 'done' && identityStatus !== 'error' && (
              <div style={{ color: '#8b3dff', fontSize: '13px', padding: '16px 0' }}>
                {identityStatus === 'loading' && '🔎 Loading encrypted record…'}
                {identityStatus === 'signing' && '🖊️ Approve the decryption request in your wallet…'}
                {identityStatus === 'decrypting' && '🔐 Decrypting with Seal…'}
              </div>
            )}

            {identityStatus === 'error' && (
              <div style={{ background: '#fdeeee', border: '1px solid #f5d0d0', borderRadius: '8px', padding: '12px', color: '#d23f3f', fontSize: '12px', lineHeight: 1.5 }}>
                ⚠️ {identityError}
              </div>
            )}

            {identityStatus === 'done' && identityData && (
              <div style={{ background: '#f3e8ff', border: '1px solid #e0c8fa', borderRadius: '8px', padding: '14px' }}>
                {Object.entries(identityData).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '5px 0', borderBottom: '1px solid #e0c8fa' }}>
                    <span style={{ color: '#717171', fontSize: '12px', textTransform: 'capitalize' }}>{k.replace(/([A-Z])/g, ' $1')}</span>
                    <span style={{ color: '#222', fontSize: '12px', textAlign: 'right', wordBreak: 'break-word' }}>{String(v)}</span>
                  </div>
                ))}
                <p style={{ color: '#717171', fontSize: '10px', margin: '10px 0 0', lineHeight: 1.5 }}>
                  Decrypted in your browser via Seal. ARIA never sees this data. Access ends automatically when the booking settles.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: '18px' }}>
              <button onClick={() => { setIdentityModal(null); setIdentityData(null); setIdentityStatus('idle'); setIdentityError(''); }}
                style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '11px', fontSize: '13px', cursor: 'pointer' }}>
                Close
              </button>
              {identityStatus === 'error' && (
                <button onClick={() => handleViewIdentity(identityModal)}
                  style={{ flex: 1, background: '#8b3dff', border: 'none', color: '#fff', borderRadius: '8px', padding: '11px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Phase 3a: Add Property — paste-from-Airbnb/VRBO, manual entry, or bulk import */}
      {showAddModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px', overflowY: 'auto' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '640px', padding: '28px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '4px' }}>
              <h3 style={{ margin: 0, fontSize: '19px', fontWeight: '700', color: '#222' }}>{editingId ? 'Edit Listing' : 'Add Property'}</h3>
              <button onClick={() => { setShowAddModal(false); setEditingId(null); }} style={{ background: 'none', border: 'none', color: '#717171', fontSize: '20px', cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 18px' }}>
              {editingId ? 'Update any fields below and save — changes apply immediately.' : addMode === 'bulk' ? 'Paste several listings at once — useful if you have dozens to onboard.' : 'Paste your existing Airbnb/VRBO listing text, or fill it in by hand.'}
            </p>

            {!editingId && (
              <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
                {[['import', '📋 Paste Listing'], ['manual', '✏️ Manual Entry'], ['bulk', '📚 Bulk Import']].map(([m, label]) => (
                  <button key={m} onClick={() => openAddModal(m)}
                    style={{ flex: 1, background: addMode === m ? '#ff385c' : 'transparent', color: addMode === m ? '#fff' : '#717171', border: `1px solid ${addMode === m ? '#ff385c' : '#ddd'}`, borderRadius: '6px', padding: '8px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* ── Paste-import mode: URL (reference only, never fetched) + text → AI draft ── */}
            {addMode === 'import' && !draft && (
              <div>
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '12px', color: '#717171', marginBottom: '6px', fontWeight: '600' }}>AIRBNB/VRBO LISTING URL (optional, for your reference)</div>
                  <input value={importUrl} onChange={e => setImportUrl(e.target.value)} placeholder="https://airbnb.com/rooms/..."
                    style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '12px', color: '#717171', marginBottom: '6px', fontWeight: '600' }}>PASTE YOUR LISTING DESCRIPTION</div>
                  <textarea value={importText} onChange={e => setImportText(e.target.value)} rows={7} placeholder="Copy the title, description, and amenities from your Airbnb/VRBO page and paste them here..."
                    style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
                  <p style={{ color: '#999', fontSize: '11px', margin: '6px 0 0', lineHeight: 1.5 }}>We never fetch or scrape the URL — it's stored only as a reference. AI reads the text you paste to fill in the listing fields below for you to review.</p>
                </div>
                {extractError && <div style={{ background: '#fdeeee', border: '1px solid #f5d0d0', borderRadius: '8px', padding: '10px 12px', color: '#d23f3f', fontSize: '12px', marginBottom: '14px' }}>⚠️ {extractError}</div>}
                <button onClick={handleExtract} disabled={extracting || !importText.trim()}
                  style={{ width: '100%', background: extracting ? '#eee' : '#ff385c', color: extracting ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: extracting ? 'wait' : 'pointer' }}>
                  {extracting ? '🤖 Extracting...' : '🤖 Extract with AI'}
                </button>
              </div>
            )}

            {/* ── Review/edit form: shown for manual entry immediately, or after extraction ── */}
            {(addMode === 'manual' || (addMode === 'import' && draft)) && draft && (
              <div>
                {addMode === 'import' && (
                  <div style={{ background: '#eafaf0', border: '1px solid #c8ebd9', borderRadius: '8px', padding: '10px 12px', color: '#00913f', fontSize: '12px', marginBottom: '16px' }}>
                    ✓ Extracted — review and edit anything below before publishing.
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <div style={{ fontSize: '11px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>TITLE</div>
                    <input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}
                      style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '9px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>DESCRIPTION</div>
                    <textarea value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} rows={4}
                      style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '9px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>LOCATION</div>
                      <input value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} placeholder="City, State"
                        style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '9px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>PRICE/NIGHT ($)</div>
                      <input type="number" min="1" value={draft.price} onChange={e => setDraft({ ...draft, price: Number(e.target.value) })}
                        style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '9px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '12px' }}>
                    {[['beds', 'BEDS'], ['baths', 'BATHS'], ['maxGuests', 'MAX GUESTS']].map(([field, label]) => (
                      <div key={field}>
                        <div style={{ fontSize: '11px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>{label}</div>
                        <input type="number" min="1" value={draft[field]} onChange={e => setDraft({ ...draft, [field]: Number(e.target.value) })}
                          style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '9px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
                      </div>
                    ))}
                    <div>
                      <div style={{ fontSize: '11px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>TAG</div>
                      <input value={draft.tag} onChange={e => setDraft({ ...draft, tag: e.target.value })}
                        style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '9px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>TAX JURISDICTION</div>
                      <input value={draft.taxJurisdiction} onChange={e => setDraft({ ...draft, taxJurisdiction: e.target.value })} placeholder="e.g. Buncombe County, NC"
                        style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '9px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>TAX RATE (%)</div>
                      <input type="number" min="0" max="20" step="0.1" value={(draft.taxRate * 100).toFixed(2)} onChange={e => setDraft({ ...draft, taxRate: Math.min(20, Math.max(0, Number(e.target.value))) / 100 })}
                        style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '9px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                  <p style={{ color: '#999', fontSize: '11px', margin: 0, lineHeight: 1.5 }}>You're responsible for the tax rate being correct and for remitting it — ARIA just collects what you declare here (capped at 20%) at booking time.</p>
                  <div>
                    <div style={{ fontSize: '11px', color: '#717171', marginBottom: '6px', fontWeight: '600' }}>PHOTOS</div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                      {(draft.images || []).map((url, i) => (
                        <div key={i} style={{ position: 'relative' }}>
                          <img src={url} alt="" style={{ width: '64px', height: '64px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #ddd' }} />
                          <button onClick={() => setDraft({ ...draft, images: draft.images.filter((_, idx) => idx !== i) })}
                            style={{ position: 'absolute', top: '-6px', right: '-6px', background: '#d23f3f', color: '#fff', border: 'none', borderRadius: '50%', width: '18px', height: '18px', fontSize: '11px', cursor: 'pointer', lineHeight: '18px' }}>×</button>
                        </div>
                      ))}
                    </div>
                    <label style={{ display: 'inline-block', background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '8px 14px', fontSize: '12px', color: '#717171', cursor: 'pointer' }}>
                      {uploadingPhoto ? 'Uploading...' : '+ Upload Photo'}
                      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} disabled={uploadingPhoto}
                        onChange={e => { uploadPhoto(e.target.files?.[0], url => setDraft(d => ({ ...d, images: [...(d.images || []), url] }))); e.target.value = ''; }} />
                    </label>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '22px' }}>
                  <button onClick={() => { setShowAddModal(false); setEditingId(null); }} style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '12px', fontSize: '14px', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={handlePublish} disabled={publishing}
                    style={{ flex: 2, background: publishing ? '#eee' : '#ff385c', color: publishing ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: publishing ? 'wait' : 'pointer' }}>
                    {publishing ? (editingId ? 'Saving...' : 'Publishing...') : (editingId ? '✓ Save Changes' : '✓ Publish Listing')}
                  </button>
                </div>
              </div>
            )}

            {/* ── Bulk import mode: many {url, text} blocks → drafts table → publish each ── */}
            {addMode === 'bulk' && (
              <div>
                {bulkDrafts.length === 0 ? (
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxHeight: '40vh', overflowY: 'auto', marginBottom: '14px' }}>
                      {bulkBlocks.map((b, i) => (
                        <div key={i} style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '8px', padding: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                            <span style={{ fontSize: '11px', color: '#717171', fontWeight: '600' }}>LISTING {i + 1}</span>
                            {bulkBlocks.length > 1 && (
                              <button onClick={() => setBulkBlocks(prev => prev.filter((_, idx) => idx !== i))} style={{ background: 'none', border: 'none', color: '#999', fontSize: '12px', cursor: 'pointer' }}>Remove</button>
                            )}
                          </div>
                          <input value={b.url} onChange={e => updateBulkBlock(i, 'url', e.target.value)} placeholder="Listing URL (optional)"
                            style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '8px 10px', color: '#222', fontSize: '12px', outline: 'none', boxSizing: 'border-box', marginBottom: '8px' }} />
                          <textarea value={b.text} onChange={e => updateBulkBlock(i, 'text', e.target.value)} rows={3} placeholder="Paste listing description..."
                            style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '8px 10px', color: '#222', fontSize: '12px', outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setBulkBlocks(prev => [...prev, { url: '', text: '' }])}
                      style={{ background: 'transparent', border: '1px dashed #ddd', color: '#717171', borderRadius: '8px', padding: '10px', fontSize: '12px', cursor: 'pointer', width: '100%', marginBottom: '14px' }}>
                      + Add another listing
                    </button>
                    <button onClick={handleBulkExtract} disabled={bulkExtracting || !bulkBlocks.some(b => b.text.trim())}
                      style={{ width: '100%', background: bulkExtracting ? '#eee' : '#ff385c', color: bulkExtracting ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: bulkExtracting ? 'wait' : 'pointer' }}>
                      {bulkExtracting ? `🤖 Extracting ${bulkBlocks.filter(b => b.text.trim()).length} listings...` : `🤖 Extract All (${bulkBlocks.filter(b => b.text.trim()).length})`}
                    </button>
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <span style={{ fontSize: '12px', color: '#717171' }}>
                        {bulkDrafts.filter(d => d.draft).length} extracted · {bulkDrafts.filter(d => d.published).length} published · {bulkDrafts.filter(d => d.error).length} failed
                      </span>
                      <button onClick={() => { setBulkBlocks([{ url: '', text: '' }]); setBulkDrafts([]); }} style={{ background: 'none', border: 'none', color: '#999', fontSize: '12px', cursor: 'pointer' }}>← Start over</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '45vh', overflowY: 'auto', marginBottom: '14px' }}>
                      {bulkDrafts.map((d, i) => (
                        <div key={i} style={{ background: '#f7f7f7', border: `1px solid ${d.published ? '#c8ebd9' : d.error ? '#f5d0d0' : '#ebebeb'}`, borderRadius: '8px', padding: '12px' }}>
                          {d.error ? (
                            <div style={{ color: '#d23f3f', fontSize: '12px' }}>⚠️ Listing {i + 1}: {d.error}</div>
                          ) : (
                            <>
                              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                                <input value={d.draft.title} onChange={e => updateBulkDraftField(i, 'title', e.target.value)} disabled={d.published}
                                  style={{ flex: 2, background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '7px 10px', color: '#222', fontSize: '12px', outline: 'none' }} />
                                <input type="number" value={d.draft.price} onChange={e => updateBulkDraftField(i, 'price', Number(e.target.value))} disabled={d.published}
                                  style={{ flex: 1, background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '7px 10px', color: '#222', fontSize: '12px', outline: 'none' }} />
                              </div>
                              <input value={d.draft.location} onChange={e => updateBulkDraftField(i, 'location', e.target.value)} disabled={d.published}
                                style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '7px 10px', color: '#222', fontSize: '12px', outline: 'none', boxSizing: 'border-box', marginBottom: '8px' }} />
                              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                {d.published ? (
                                  <span style={{ color: '#00913f', fontSize: '12px', fontWeight: '600' }}>✓ Published</span>
                                ) : (
                                  <button onClick={() => handleBulkPublishOne(i)} disabled={d.publishing}
                                    style={{ background: d.publishing ? '#eee' : '#ff385c', color: d.publishing ? '#999' : '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', fontSize: '11px', fontWeight: '700', cursor: d.publishing ? 'wait' : 'pointer' }}>
                                    {d.publishing ? 'Publishing...' : 'Publish'}
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={() => setShowAddModal(false)} style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '12px', fontSize: '14px', cursor: 'pointer' }}>Close</button>
                      <button onClick={handleBulkPublishAll} disabled={!bulkDrafts.some(d => d.draft && !d.published)}
                        style={{ flex: 2, background: '#ff385c', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}>
                        Publish All Remaining
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
