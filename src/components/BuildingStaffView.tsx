import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useAppContext, isPetugasGedungRole, isQcRole } from '../store';
import { Room, MeetingRoom, CleaningLog, Building } from '../types';
import { 
  formatIndonesianDate, 
  formatRupiah, 
  compareBuildingOrder, 
  isMeetingFacility, 
  resolveRoomBuildingName, 
  isRoomMatchingBuilding, 
  extractFloorFromRoomNumber 
} from '../lib/utils';
import { OFFICIAL_TARIFFS } from '../data';

// Helper for building icons matching QualityControlView & RoomsView
const PENGINAPAN_ICONS = [
  'fa-hotel',
  'fa-city',
  'fa-building-columns',
  'fa-building-user',
  'fa-house-chimney-window',
  'fa-building-shield',
  'fa-building-flag',
  'fa-tower-observation',
  'fa-archway',
  'fa-landmark-dome'
];

function getBuildingIcon(bName: string, category?: string): string {
  const norm = String(bName || '').toLowerCase();
  if (category === 'SERBAGUNA' || norm.includes('serbaguna') || norm.includes('sg-') || norm.includes('(sg)')) {
    return 'fa-layer-group';
  }
  if (category === 'RUANG_PERTEMUAN' || norm.includes('ruang pertemuan') || norm.includes('aula') || norm.includes('auditorium')) {
    return 'fa-landmark';
  }
  if (norm.includes('arafah')) return 'fa-kaaba';
  if (norm.includes('muzdalifah')) return 'fa-mosque';
  if (norm.includes('mina')) return 'fa-tents';
  if (norm.includes('madinah')) return 'fa-archway';
  if (norm.includes('sekretariat') || norm.includes('kantor')) return 'fa-building-columns';
  
  let hash = 0;
  const str = String(bName || '');
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return PENGINAPAN_ICONS[hash % PENGINAPAN_ICONS.length];
}

// Function to burn real date/time timestamp & official info onto an image via HTML5 Canvas
function applyWatermarkToImage(
  imageSrc: string,
  meta: {
    roomNumber: string;
    building: string;
    petugasName: string;
    petugasRole: string;
  }
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const maxDim = 1600;
        let width = img.width;
        let height = img.height;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(imageSrc);
          return;
        }

        // Draw captured image
        ctx.drawImage(img, 0, 0, width, height);

        // Real timestamp in Indonesian WIB format
        const now = new Date();
        const dateOptions: Intl.DateTimeFormatOptions = {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        };
        const timeOptions: Intl.DateTimeFormatOptions = {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        };
        const dateStr = now.toLocaleDateString('id-ID', dateOptions);
        const timeStr = now.toLocaleTimeString('id-ID', timeOptions);
        const fullTimeStr = `${dateStr} • ${timeStr} WIB`;

        // Calculate dynamic dimensions for watermark overlay
        const baseFontSize = Math.max(14, Math.round(width * 0.024));
        const padding = Math.max(16, Math.round(width * 0.025));
        const bannerHeight = Math.max(105, Math.round(baseFontSize * 4.6 + padding * 1.8));

        // Draw bottom gradient banner overlay
        const gradient = ctx.createLinearGradient(0, height - bannerHeight - 40, 0, height);
        gradient.addColorStop(0, 'rgba(15, 23, 42, 0)');
        gradient.addColorStop(0.2, 'rgba(15, 23, 42, 0.82)');
        gradient.addColorStop(1, 'rgba(2, 6, 23, 0.98)');

        ctx.fillStyle = gradient;
        ctx.fillRect(0, height - bannerHeight - 40, width, bannerHeight + 40);

        // Decorative teal accent bar
        ctx.fillStyle = '#0d9488'; // teal-600
        ctx.fillRect(padding, height - bannerHeight + 4, 6, bannerHeight - padding * 0.9);

        // Watermark Texts
        ctx.textBaseline = 'top';

        // Line 1: Real Date & Time
        ctx.font = `bold ${Math.round(baseFontSize * 1.05)}px sans-serif`;
        ctx.fillStyle = '#fbbf24'; // gold-400
        const textX = padding + 16;
        let textY = height - bannerHeight + 4;
        ctx.fillText(`🕒 ${fullTimeStr}`, textX, textY);

        // Line 2: Building & Room Location
        textY += baseFontSize * 1.35;
        ctx.font = `bold ${Math.round(baseFontSize * 1.2)}px sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`📍 ${meta.building} — ${meta.roomNumber}`, textX, textY);

        // Line 3: Petugas & Division
        textY += baseFontSize * 1.35;
        ctx.font = `normal ${Math.round(baseFontSize * 0.95)}px sans-serif`;
        ctx.fillStyle = '#cbd5e1'; // slate-300
        ctx.fillText(`👤 Petugas: ${meta.petugasName} (${meta.petugasRole})`, textX, textY);

        // Line 4: Official Stamp Brand
        textY += baseFontSize * 1.25;
        ctx.font = `italic ${Math.round(baseFontSize * 0.8)}px sans-serif`;
        ctx.fillStyle = '#94a3b8'; // slate-400
        ctx.fillText(`UPT ASRAMA HAJI JAKARTA • BUKTI STERILISASI & KEBERSIHAN RUANGAN RESMI`, textX, textY);

        // Top right verified badge
        const badgeW = Math.max(160, Math.round(width * 0.24));
        const badgeH = Math.max(34, Math.round(baseFontSize * 1.9));
        ctx.fillStyle = 'rgba(13, 148, 136, 0.9)'; // teal
        ctx.beginPath();
        if (typeof (ctx as any).roundRect === 'function') {
          (ctx as any).roundRect(width - badgeW - padding, padding, badgeW, badgeH, 8);
        } else {
          ctx.rect(width - badgeW - padding, padding, badgeW, badgeH);
        }
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(baseFontSize * 0.8)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('BUKTI KAMERA REAL', width - badgeW / 2 - padding, padding + badgeH / 2);
        ctx.textAlign = 'left';

        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (err) {
        console.error('Error drawing canvas watermark:', err);
        resolve(imageSrc);
      }
    };
    img.onerror = () => {
      resolve(imageSrc);
    };
    img.src = imageSrc;
  });
}

export function BuildingStaffView() {
  const { 
    rooms = [], meetingRooms = [], buildings = [], cleaningLogs = [], 
    addCleaningLog, updateCleaningLog, deleteCleaningLog, updateRoom, updateMeetingRoom, 
    currentUser, showToast, setSelectedBuilding, setActiveTab 
  } = useAppContext();

  // Navigation & Sub-Tabs: PENGINAPAN, RUANG_PERTEMUAN, DATABASE_CRUD
  const [activeSubTab, setActiveSubTab] = useState<'PENGINAPAN' | 'RUANG_PERTEMUAN' | 'DATABASE_CRUD'>('PENGINAPAN');
  const [bFilter, setBFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeBuildingName, setActiveBuildingName] = useState<string>('');
  const [buildingFloorFilters, setBuildingFloorFilters] = useState<Record<string, number | 'ALL'>>({});

  // CRUD & Upload Modal State
  const [isCleaningModalOpen, setIsCleaningModalOpen] = useState(false);
  const [targetItem, setTargetItem] = useState<{ id: string; number: string; building: string; type: 'ROOM' | 'MEETING'; category?: string } | null>(null);
  const [cleaningNotes, setCleaningNotes] = useState('');
  const [isProcessingWatermark, setIsProcessingWatermark] = useState(false);
  const [watermarkedPhotoUrl, setWatermarkedPhotoUrl] = useState<string | null>(null);

  // Edit Cleaning Log Modal (CRUD Update)
  const [editingLog, setEditingLog] = useState<CleaningLog | null>(null);
  const [editNotes, setEditNotes] = useState('');
  const [editStatus, setEditStatus] = useState<CleaningLog['status']>('MENUNGGU_QC');

  // Lightbox Modal for Full Image View (CRUD Read)
  const [previewLightboxLog, setPreviewLightboxLog] = useState<CleaningLog | null>(null);

  // Delete Confirmation Modal (CRUD Delete)
  const [logToDelete, setLogToDelete] = useState<CleaningLog | null>(null);

  // File Inputs
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  const canClean = isPetugasGedungRole(currentUser?.role) || Boolean(currentUser && (currentUser.role === 'Super Admin' || currentUser.role === 'Admin'));
  const canInspectQc = isQcRole(currentUser?.role) || Boolean(currentUser && (currentUser.role === 'Super Admin' || currentUser.role === 'Admin'));

  // Master lodging buildings (selaras dengan QualityControlView & Denah Gedung)
  const lodgingBuildings = useMemo(() => {
    return (buildings || [])
      .filter(b => {
        const name = b.name || '';
        const cat = b.category || '';
        if (name === 'Ruang Pertemuan' || name === 'Ruang Pertemuan / Aula' || name === 'Gedung Serbaguna' || name === 'Gedung Serbaguna (SG)') return false;
        if (cat === 'SERBAGUNA' || cat === 'RUANG_PERTEMUAN') return false;
        if (isMeetingFacility(name)) return false;
        return true;
      })
      .slice()
      .sort((a, b) => compareBuildingOrder(a.name, b.name));
  }, [buildings]);

  // Master lodging rooms
  const lodgingRooms = useMemo(() => {
    return rooms.filter(r => {
      const bKey = resolveRoomBuildingName(r, lodgingBuildings, meetingRooms);
      if (isMeetingFacility(bKey)) return false;
      if (r.building === 'Ruang Pertemuan' || r.building === 'Ruang Pertemuan / Aula' || r.building === 'Gedung Serbaguna (SG)') return false;
      return true;
    });
  }, [rooms, lodgingBuildings, meetingRooms]);

  // Group rooms by lodging building
  const groupedLodgingRooms = useMemo(() => {
    const map: Record<string, Room[]> = {};
    lodgingBuildings.forEach(b => {
      map[b.name] = [];
    });

    lodgingRooms.forEach(r => {
      const matchedBld = lodgingBuildings.find(b => isRoomMatchingBuilding(r, b, meetingRooms));
      const bName = matchedBld ? matchedBld.name : r.building || (lodgingBuildings[0] ? lodgingBuildings[0].name : 'Gedung A (Arafah)');
      if (!map[bName]) {
        map[bName] = [];
      }
      map[bName].push(r);
    });

    // Urutkan kamar per gedung berdasarkan lantai & nomor
    Object.keys(map).forEach(bName => {
      map[bName].sort((a, b) => {
        const flA = a.floor || extractFloorFromRoomNumber(a.roomNumber) || 1;
        const flB = b.floor || extractFloorFromRoomNumber(b.roomNumber) || 1;
        if (flA !== flB) return flA - flB;
        return String(a.roomNumber || '').localeCompare(String(b.roomNumber || ''), undefined, { numeric: true });
      });
    });

    return map;
  }, [lodgingRooms, lodgingBuildings, meetingRooms]);

  // Filtered lodging building names
  const buildingNames = useMemo(() => {
    return lodgingBuildings.map(b => b.name);
  }, [lodgingBuildings]);

  // Set default active building
  useEffect(() => {
    if (!activeBuildingName && buildingNames.length > 0) {
      setActiveBuildingName(buildingNames[0]);
    }
  }, [buildingNames, activeBuildingName]);

  const selectedBuildingKey = useMemo(() => {
    if (activeBuildingName && buildingNames.includes(activeBuildingName)) {
      return activeBuildingName;
    }
    return buildingNames[0] || '';
  }, [activeBuildingName, buildingNames]);

  // Combined statistics
  const totalRoomsCount = lodgingRooms.length;
  const totalMeetingCount = meetingRooms.length;
  const allFacilitiesCount = totalRoomsCount + totalMeetingCount;

  const perluInspeksiRooms = lodgingRooms.filter(r => !r.qcStatus || r.qcStatus === 'PERLU_INSPEKSI').length;
  const menungguQcRooms = lodgingRooms.filter(r => r.qcStatus === 'MENUNGGU_QC').length;
  const lolosQcRooms = lodgingRooms.filter(r => r.qcStatus === 'LOLOS_QC').length;

  const perluInspeksiMeeting = meetingRooms.filter(m => !m.qcStatus || m.qcStatus === 'PERLU_INSPEKSI').length;
  const menungguQcMeeting = meetingRooms.filter(m => m.qcStatus === 'MENUNGGU_QC').length;
  const lolosQcMeeting = meetingRooms.filter(m => m.qcStatus === 'LOLOS_QC').length;

  const totalPerluInspeksi = perluInspeksiRooms + perluInspeksiMeeting;
  const totalMenungguQc = menungguQcRooms + menungguQcMeeting;
  const totalLolosQc = lolosQcRooms + lolosQcMeeting;

  // Handle Photo File Selection from real Camera or Folder
  const handleImageFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !targetItem) return;

    // Check file type
    if (!file.type.startsWith('image/')) {
      showToast('Harap pilih berkas foto yang valid (JPG, PNG, WEBP).', 'error');
      return;
    }

    setIsProcessingWatermark(true);
    const reader = new FileReader();

    reader.onload = async (event) => {
      const rawDataUrl = event.target?.result as string;
      if (!rawDataUrl) {
        setIsProcessingWatermark(false);
        return;
      }

      try {
        const watermarked = await applyWatermarkToImage(rawDataUrl, {
          roomNumber: targetItem.type === 'ROOM' ? `Kamar ${targetItem.number}` : targetItem.number,
          building: targetItem.building,
          petugasName: currentUser?.fullName || 'Petugas Gedung UPT',
          petugasRole: currentUser?.role || 'Petugas Gedung'
        });

        setWatermarkedPhotoUrl(watermarked);
        showToast('Foto dari kamera/perangkat berhasil dimuat dan diberi watermark waktu real!', 'success');
      } catch (err) {
        console.error('Failed to watermark image:', err);
        setWatermarkedPhotoUrl(rawDataUrl);
      } finally {
        setIsProcessingWatermark(false);
      }
    };

    reader.onerror = () => {
      showToast('Gagal membaca berkas foto dari perangkat.', 'error');
      setIsProcessingWatermark(false);
    };

    reader.readAsDataURL(file);
    // Reset file input value so user can re-select same file if needed
    e.target.value = '';
  };

  // Open Cleaning Modal for a Room or Meeting Facility
  const handleOpenCleaningModal = (item: { id: string; number: string; building: string; type: 'ROOM' | 'MEETING'; category?: string }) => {
    setTargetItem(item);
    setCleaningNotes('Pembersihan menyeluruh pasca penggunaan. Penggantian sprei set baru, sanitasi kamar mandi, penyedotan debu karpet, dan disinfeksi.');
    setWatermarkedPhotoUrl(null);
    setIsCleaningModalOpen(true);
  };

  // Submit Cleaning Report
  const handleSubmitCleaningReport = (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetItem) return;

    if (!watermarkedPhotoUrl) {
      showToast('Harap ambil foto melalui kamera perangkat atau pilih dari folder sebagai bukti real sebelum mengirim laporan!', 'error');
      return;
    }

    const nowStr = new Date().toLocaleString('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'medium'
    });

    const newLog: CleaningLog = {
      id: `clean-${Date.now()}`,
      roomId: targetItem.type === 'ROOM' ? targetItem.id : undefined,
      meetingRoomId: targetItem.type === 'MEETING' ? targetItem.id : undefined,
      building: targetItem.building,
      roomNumber: targetItem.number,
      petugasId: currentUser?.id || 'petugas-1',
      petugasName: currentUser?.fullName || 'Petugas Gedung UPT',
      timestamp: nowStr,
      photoUrl: watermarkedPhotoUrl,
      notes: cleaningNotes.trim() || 'Pembersihan steril selesai.',
      status: 'MENUNGGU_QC'
    };

    addCleaningLog(newLog);

    if (targetItem.type === 'ROOM') {
      const roomObj = rooms.find(r => r.id === targetItem.id);
      if (roomObj) {
        updateRoom({ ...roomObj, qcStatus: 'MENUNGGU_QC' });
      }
    } else {
      const mrObj = meetingRooms.find(m => m.id === targetItem.id);
      if (mrObj) {
        updateMeetingRoom({ ...mrObj, qcStatus: 'MENUNGGU_QC' });
      }
    }

    showToast(`Laporan pembersihan ${targetItem.number} berhasil dikirim dengan bukti foto real ber-watermark waktu! Status beralih ke Menunggu QC.`, 'success');
    setIsCleaningModalOpen(false);
    setTargetItem(null);
    setWatermarkedPhotoUrl(null);
  };

  // CRUD: Handle Edit Cleaning Log (Update)
  const handleOpenEditLog = (log: CleaningLog) => {
    setEditingLog(log);
    setEditNotes(log.notes);
    setEditStatus(log.status);
  };

  const handleSaveEditLog = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLog) return;

    const updated: CleaningLog = {
      ...editingLog,
      notes: editNotes.trim(),
      status: editStatus
    };

    updateCleaningLog(updated);

    // Sync status to room or meeting room
    if (editingLog.roomId) {
      const r = rooms.find(item => item.id === editingLog.roomId || item.roomNumber === editingLog.roomNumber);
      if (r) {
        updateRoom({ ...r, qcStatus: editStatus });
      }
    } else if (editingLog.meetingRoomId) {
      const mr = meetingRooms.find(item => item.id === editingLog.meetingRoomId || item.code === editingLog.roomNumber || item.name === editingLog.roomNumber);
      if (mr) {
        updateMeetingRoom({ ...mr, qcStatus: editStatus });
      }
    }

    showToast(`Laporan pembersihan ${editingLog.roomNumber} berhasil diperbarui.`, 'success');
    setEditingLog(null);
  };

  // CRUD: Handle Delete Cleaning Log
  const handleConfirmDelete = () => {
    if (!logToDelete) return;
    deleteCleaningLog(logToDelete.id);
    showToast(`Laporan pembersihan ${logToDelete.roomNumber} (${logToDelete.timestamp}) berhasil dihapus.`, 'info');
    setLogToDelete(null);
  };

  // Helper to find latest cleaning log for a room/meeting room
  const getLatestCleaningLog = (identifier: string) => {
    return cleaningLogs.find(l => l.roomId === identifier || l.meetingRoomId === identifier || l.roomNumber === identifier);
  };

  return (
    <div className="space-y-4 sm:space-y-5 animate-in fade-in duration-200">
      {/* HEADER BANNER */}
      <div className="bg-gradient-to-r from-teal-900 via-hajj-900 to-slate-900 rounded-2xl p-5 sm:p-6 text-white shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border border-teal-800/40">
        <div className="flex items-center space-x-3.5">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-gold-400/20 border border-gold-300/30 flex items-center justify-center text-gold-300 text-xl shadow-inner shrink-0">
            <i className="fa-solid fa-broom"></i>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base sm:text-lg font-black tracking-wide text-white">
                Divisi Petugas Gedung &amp; Housekeeping
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-gold-400 text-slate-950 uppercase shadow-xs">
                Bukti Foto Real &amp; Watermark Waktu
              </span>
            </div>
            <p className="text-xs text-teal-100 mt-1 max-w-2xl leading-relaxed">
              Pembersihan gedung asrama, kamar hunian, dan aula pasca pakai. Menggunakan bukti foto kamera/folder asli dengan watermark waktu otomatis sebelum diverifikasi oleh tim QC.
            </p>
          </div>
        </div>

        {/* TOP SUB-TAB BUTTONS */}
        <div className="flex items-center space-x-1.5 self-stretch sm:self-auto justify-end bg-slate-950/40 p-1.5 rounded-2xl border border-white/10">
          <button
            type="button"
            onClick={() => setActiveSubTab('PENGINAPAN')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition shadow-2xs flex items-center space-x-2 cursor-pointer ${
              activeSubTab === 'PENGINAPAN' 
                ? 'bg-gold-400 text-slate-950 ring-2 ring-gold-300 font-extrabold' 
                : 'text-slate-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <i className="fa-solid fa-hotel"></i>
            <span>Gedung Kamar</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('RUANG_PERTEMUAN')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition shadow-2xs flex items-center space-x-2 cursor-pointer ${
              activeSubTab === 'RUANG_PERTEMUAN' 
                ? 'bg-gold-400 text-slate-950 ring-2 ring-gold-300 font-extrabold' 
                : 'text-slate-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <i className="fa-solid fa-landmark"></i>
            <span>Aula &amp; Serbaguna</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('DATABASE_CRUD')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition shadow-2xs flex items-center space-x-2 cursor-pointer ${
              activeSubTab === 'DATABASE_CRUD' 
                ? 'bg-gold-400 text-slate-950 ring-2 ring-gold-300 font-extrabold' 
                : 'text-slate-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <i className="fa-solid fa-database"></i>
            <span>Database CRUD ({cleaningLogs.length})</span>
          </button>
        </div>
      </div>

      {/* KPI METRICS CARDS */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xs flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 flex items-center justify-center font-bold">
            <i className="fa-solid fa-building"></i>
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-400 block">Total Fasilitas</span>
            <span className="text-base sm:text-lg font-black text-slate-800 dark:text-white">{allFacilitiesCount} Unit</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xs flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 flex items-center justify-center font-bold">
            <i className="fa-solid fa-triangle-exclamation"></i>
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-400 block">Perlu Sterilisasi</span>
            <span className="text-base sm:text-lg font-black text-amber-600">{totalPerluInspeksi} Unit</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xs flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 flex items-center justify-center font-bold">
            <i className="fa-solid fa-bell"></i>
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-400 block">Menunggu QC</span>
            <span className="text-base sm:text-lg font-black text-purple-700">{totalMenungguQc} Unit</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xs flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center font-bold">
            <i className="fa-solid fa-circle-check"></i>
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-400 block">Lolos QC / Ready</span>
            <span className="text-base sm:text-lg font-black text-emerald-600">{totalLolosQc} Unit</span>
          </div>
        </div>
      </div>

      {/* FILTER BAR & QUICK ACTION CONTROLS */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700 shadow-2xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Quick QC Status Buttons */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mr-1">Status:</span>
            <button
              type="button"
              onClick={() => setStatusFilter('ALL')}
              className={`px-3 py-1 rounded-lg font-bold text-xs transition cursor-pointer flex items-center gap-1.5 border ${
                statusFilter === 'ALL'
                  ? 'bg-slate-800 text-white border-slate-800 shadow-2xs'
                  : 'bg-slate-50 dark:bg-slate-700 hover:bg-slate-100 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600'
              }`}
            >
              <span>Semua Status</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/20 text-current">{allFacilitiesCount}</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('PERLU_INSPEKSI')}
              className={`px-3 py-1 rounded-lg font-bold text-xs transition cursor-pointer flex items-center gap-1.5 border ${
                statusFilter === 'PERLU_INSPEKSI'
                  ? 'bg-amber-600 text-white border-amber-600 shadow-2xs'
                  : 'bg-amber-50/60 dark:bg-amber-950/30 hover:bg-amber-100 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-amber-500"></span>
              <span>Perlu Sterilisasi</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/30 text-current">{totalPerluInspeksi}</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('MENUNGGU_QC')}
              className={`px-3 py-1 rounded-lg font-bold text-xs transition cursor-pointer flex items-center gap-1.5 border ${
                statusFilter === 'MENUNGGU_QC'
                  ? 'bg-purple-700 text-white border-purple-700 shadow-2xs'
                  : 'bg-purple-50/60 dark:bg-purple-950/30 hover:bg-purple-100 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-800'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-purple-500"></span>
              <span>Menunggu QC</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/30 text-current">{totalMenungguQc}</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('LOLOS_QC')}
              className={`px-3 py-1 rounded-lg font-bold text-xs transition cursor-pointer flex items-center gap-1.5 border ${
                statusFilter === 'LOLOS_QC'
                  ? 'bg-emerald-700 text-white border-emerald-700 shadow-2xs'
                  : 'bg-emerald-50/60 dark:bg-emerald-950/30 hover:bg-emerald-100 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>Lolos QC (Steril)</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/30 text-current">{totalLolosQc}</span>
            </button>
          </div>

          {/* Search Box */}
          <div className="relative w-full sm:w-64">
            <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
            <input
              type="text"
              placeholder="Cari kamar, aula, petugas..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-teal-600 font-medium"
            />
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* SUB-TAB 1: GEDUNG PENGINAPAN & KAMAR (LAYOUT MIRRORING QUALITY CONTROL) */}
      {/* ========================================================================= */}
      {activeSubTab === 'PENGINAPAN' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* SISI KIRI: DAFTAR GEDUNG PENGINAPAN (4 KOLOM) */}
            <div className="lg:col-span-4 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xs p-3.5 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-700 pb-2">
                <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">
                  Pilih Gedung Penginapan ({buildingNames.length})
                </span>
                <span className="text-[10px] text-slate-400">
                  Klik untuk kelola
                </span>
              </div>

              <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1.5 custom-scrollbar">
                {buildingNames.map(bName => {
                  const bRooms = groupedLodgingRooms[bName] || [];
                  const bObj = lodgingBuildings.find(b => b.name.toLowerCase() === bName.toLowerCase());
                  const isSelected = selectedBuildingKey.toLowerCase() === bName.toLowerCase();
                  const bLolos = bRooms.filter(r => r.qcStatus === 'LOLOS_QC').length;
                  const bMenunggu = bRooms.filter(r => r.qcStatus === 'MENUNGGU_QC').length;
                  const bPerlu = bRooms.filter(r => !r.qcStatus || r.qcStatus === 'PERLU_INSPEKSI').length;

                  return (
                    <div
                      key={bName}
                      onClick={() => setActiveBuildingName(bName)}
                      className={`p-3 rounded-xl border transition-all cursor-pointer space-y-2 ${
                        isSelected
                          ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-950/40 shadow-xs ring-2 ring-teal-500/20'
                          : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:hover:bg-slate-750'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center space-x-2.5 min-w-0">
                          <div className={`w-9 h-9 rounded-xl font-bold flex items-center justify-center text-xs shrink-0 ${
                            isSelected
                              ? 'bg-teal-700 text-white shadow-2xs'
                              : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200'
                          }`}>
                            <i className={`fa-solid ${getBuildingIcon(bName, bObj?.category)}`}></i>
                          </div>
                          <div className="min-w-0">
                            <h4 className="font-bold text-xs text-slate-900 dark:text-white truncate">
                              {bName}
                            </h4>
                            <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                              {bRooms.length} Kamar Tidur
                            </p>
                          </div>
                        </div>

                        <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase shrink-0 ${
                          isSelected
                            ? 'bg-teal-100 text-teal-800 border border-teal-300 dark:bg-teal-900 dark:text-teal-200'
                            : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                        }`}>
                          {bObj?.code || 'ASRAMA'}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[10px] pt-1.5 border-t border-slate-100 dark:border-slate-700 tabular-nums">
                        <div className="flex items-center flex-wrap gap-1.5 text-slate-600 dark:text-slate-300 font-semibold">
                          <span className="text-emerald-700 dark:text-emerald-400 font-bold">{bLolos} Lolos</span>
                          <span aria-hidden="true">·</span>
                          {bMenunggu > 0 ? (
                            <span className="text-purple-800 dark:text-purple-300 font-bold animate-pulse">{bMenunggu} Cek QC</span>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400 font-bold">{bPerlu} Perlu Bersih</span>
                          )}
                        </div>

                        {isSelected ? (
                          <span className="text-teal-700 dark:text-teal-400 font-bold flex items-center space-x-1 shrink-0">
                            <span>Aktif</span>
                            <i className="fa-solid fa-chevron-right text-[9px]"></i>
                          </span>
                        ) : (
                          <span className="text-slate-400 font-medium shrink-0">
                            Pilih
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* SISI KANAN: DAFTAR KAMAR DARI GEDUNG TERPILIH (8 KOLOM) */}
            <div className="lg:col-span-8 space-y-4">
              {selectedBuildingKey ? (() => {
                const bName = selectedBuildingKey;
                const bRooms = groupedLodgingRooms[bName] || [];
                const bObj = lodgingBuildings.find(b => b.name.toLowerCase() === bName.toLowerCase());
                const bDescription = (bObj?.description && String(bObj.description).trim())
                  || OFFICIAL_TARIFFS[bName]?.desc
                  || 'Fasilitas Kamar Hunian UPT Asrama Haji Jakarta';

                const floorsInBuilding = Array.from(
                  new Set<number>(bRooms.map(r => Number(r.floor || extractFloorFromRoomNumber(r.roomNumber) || 1)))
                ).sort((a: number, b: number) => a - b);
                const currentFloorFilter = buildingFloorFilters[bName] || 'ALL';

                // Apply floor filter, status filter, and search
                const displayedRooms = bRooms.filter(r => {
                  const rFloor = r.floor || extractFloorFromRoomNumber(r.roomNumber) || 1;
                  if (currentFloorFilter !== 'ALL' && rFloor !== currentFloorFilter) return false;
                  if (statusFilter !== 'ALL') {
                    const q = r.qcStatus || 'PERLU_INSPEKSI';
                    if (q !== statusFilter) return false;
                  }
                  if (searchQuery && String(searchQuery).trim()) {
                    const q = String(searchQuery).toLowerCase().trim();
                    const matchNum = String(r.roomNumber || '').toLowerCase().includes(q);
                    const matchType = String(r.type || '').toLowerCase().includes(q);
                    if (!matchNum && !matchType) return false;
                  }
                  return true;
                });

                return (
                  <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xs p-4 sm:p-5 space-y-4">
                    {/* Header Gedung Terpilih */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-700 pb-4">
                      <div className="flex items-center space-x-3.5">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-teal-600 to-teal-800 text-white font-black text-lg flex items-center justify-center shadow-xs shrink-0">
                          <i className={`fa-solid ${getBuildingIcon(bName, bObj?.category)}`}></i>
                        </div>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-black text-base text-slate-900 dark:text-white">
                              {bName}
                            </h3>
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase bg-teal-100 dark:bg-teal-900 text-teal-900 dark:text-teal-200 border border-teal-300 dark:border-teal-700">
                              {bObj?.code || 'PENGINAPAN'}
                            </span>
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 tabular-nums">
                              {floorsInBuilding.length || 1} Lantai • {bRooms.length} Kamar
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {bDescription}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedBuilding(bName);
                            setActiveTab('gedung');
                          }}
                          className="px-3 py-1.5 bg-slate-100 dark:bg-slate-700 hover:bg-teal-50 border border-slate-200 dark:border-slate-600 hover:border-teal-300 text-slate-700 dark:text-slate-200 hover:text-teal-700 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                        >
                          <i className="fa-solid fa-map-location-dot text-teal-600"></i>
                          <span>Denah Gedung</span>
                        </button>
                      </div>
                    </div>

                    {/* Bar Filter Lantai & Ringkasan */}
                    <div className="bg-slate-50 dark:bg-slate-750 p-3 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-center flex-wrap gap-1">
                        <span className="text-[11px] font-bold text-slate-500 mr-1">Filter Lantai:</span>
                        <button
                          type="button"
                          onClick={() => setBuildingFloorFilters(prev => ({ ...prev, [bName]: 'ALL' }))}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer tabular-nums whitespace-nowrap shrink-0 ${
                            currentFloorFilter === 'ALL'
                              ? 'bg-teal-700 text-white shadow-2xs'
                              : 'bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          Semua ({bRooms.length})
                        </button>
                        {floorsInBuilding.map(fl => {
                          const countInFloor = bRooms.filter(r => (r.floor || extractFloorFromRoomNumber(r.roomNumber) || 1) === fl).length;
                          return (
                            <button
                              key={fl}
                              type="button"
                              onClick={() => setBuildingFloorFilters(prev => ({ ...prev, [bName]: fl }))}
                              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer tabular-nums whitespace-nowrap shrink-0 ${
                                currentFloorFilter === fl
                                  ? 'bg-teal-700 text-white shadow-2xs'
                                  : 'bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 text-slate-700 dark:text-slate-200'
                              }`}
                            >
                              Lt {fl} ({countInFloor})
                            </button>
                          );
                        })}
                      </div>

                      <div className="text-[11px] font-bold text-slate-500">
                        Menampilkan {displayedRooms.length} kamar
                      </div>
                    </div>

                    {/* GRID KARTU KAMAR (LAYOUT MIRRORING QUALITY CONTROL) */}
                    {displayedRooms.length === 0 ? (
                      <div className="bg-slate-50 dark:bg-slate-750 p-8 text-center rounded-xl border border-dashed border-slate-200 dark:border-slate-700 text-slate-400">
                        <i className="fa-solid fa-broom text-3xl mb-2 text-slate-300"></i>
                        <p className="text-xs font-semibold">Tidak ada kamar yang sesuai dengan kriteria filter.</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                        {displayedRooms.map(room => {
                          const qc = room.qcStatus || 'PERLU_INSPEKSI';
                          const latestLog = getLatestCleaningLog(room.id) || getLatestCleaningLog(room.roomNumber);

                          return (
                            <div
                              key={room.id}
                              className={`rounded-2xl border p-3.5 flex flex-col justify-between transition-all shadow-2xs ${
                                qc === 'LOLOS_QC'
                                  ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/20 dark:bg-emerald-950/10'
                                  : qc === 'MENUNGGU_QC'
                                  ? 'border-purple-300 dark:border-purple-800 bg-purple-50/30 dark:bg-purple-950/15 ring-1 ring-purple-300/40'
                                  : 'border-amber-200 dark:border-amber-800 bg-amber-50/20 dark:bg-amber-950/10'
                              }`}
                            >
                              <div className="space-y-2">
                                {/* Room Number & Status Badges */}
                                <div className="flex items-start justify-between gap-1">
                                  <div>
                                    <div className="flex items-center space-x-1.5">
                                      <i className="fa-solid fa-door-open text-teal-600 text-xs"></i>
                                      <span className="font-black text-sm text-slate-900 dark:text-white">
                                        Kamar {room.roomNumber}
                                      </span>
                                    </div>
                                    <span className="text-[10px] text-slate-400 block">
                                      Lantai {room.floor || extractFloorFromRoomNumber(room.roomNumber) || 1} • {room.type || 'Standar'}
                                    </span>
                                  </div>

                                  <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase shrink-0 ${
                                    room.status === 'TERISI'
                                      ? 'bg-rose-100 text-rose-800'
                                      : room.status === 'BOOKED'
                                      ? 'bg-blue-100 text-blue-800'
                                      : room.status === 'MAINTENANCE'
                                      ? 'bg-amber-100 text-amber-800'
                                      : 'bg-emerald-100 text-emerald-800'
                                  }`}>
                                    {room.status}
                                  </span>
                                </div>

                                {/* Housekeeping & QC Badge */}
                                <div>
                                  {qc === 'LOLOS_QC' ? (
                                    <div className="px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center space-x-1.5">
                                      <i className="fa-solid fa-circle-check text-emerald-600"></i>
                                      <span>Lolos QC (Steril &amp; Siap Huni)</span>
                                    </div>
                                  ) : qc === 'MENUNGGU_QC' ? (
                                    <div className="px-2 py-1 rounded-lg text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200 flex items-center space-x-1.5 animate-pulse">
                                      <i className="fa-solid fa-bell text-purple-600"></i>
                                      <span>Menunggu Verifikasi QC</span>
                                    </div>
                                  ) : (
                                    <div className="px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200 flex items-center space-x-1.5">
                                      <i className="fa-solid fa-triangle-exclamation text-amber-600"></i>
                                      <span>Perlu Sterilisasi / Bersihkan</span>
                                    </div>
                                  )}
                                </div>

                                {/* Latest Cleaning Log Info & Photo Preview */}
                                {latestLog ? (
                                  <div className="bg-white/80 dark:bg-slate-900/80 p-2 rounded-xl border border-slate-200/80 dark:border-slate-700/80 space-y-1.5 text-[10px]">
                                    <div className="flex items-center justify-between text-slate-500">
                                      <span>Petugas:</span>
                                      <span className="font-bold text-slate-800 dark:text-slate-200 truncate max-w-[120px]">{latestLog.petugasName}</span>
                                    </div>
                                    <div className="flex items-center justify-between text-slate-500">
                                      <span>Waktu Real:</span>
                                      <span className="font-mono text-slate-600 dark:text-slate-300 text-[9px]">{latestLog.timestamp}</span>
                                    </div>
                                    {latestLog.photoUrl && (
                                      <div className="pt-1 flex items-center space-x-2">
                                        <img 
                                          src={latestLog.photoUrl} 
                                          alt="Bukti Real" 
                                          className="w-10 h-10 object-cover rounded-lg border border-slate-200 dark:border-slate-700 shadow-2xs shrink-0 cursor-pointer hover:scale-105 transition"
                                          onClick={() => setPreviewLightboxLog(latestLog)}
                                          title="Klik untuk melihat bukti foto real ber-watermark waktu"
                                        />
                                        <div className="min-w-0">
                                          <button
                                            type="button"
                                            onClick={() => setPreviewLightboxLog(latestLog)}
                                            className="text-teal-700 dark:text-teal-400 font-bold hover:underline cursor-pointer flex items-center space-x-1"
                                          >
                                            <i className="fa-solid fa-camera text-[9px]"></i>
                                            <span>Lihat Bukti Foto</span>
                                          </button>
                                          <span className="text-[9px] text-slate-400 truncate block">Watermark Terverifikasi</span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="p-2 rounded-xl bg-slate-50 dark:bg-slate-900 text-center text-[10px] text-slate-400 italic">
                                    Belum ada log foto sterilisasi
                                  </div>
                                )}
                              </div>

                              {/* Action Buttons */}
                              <div className="mt-3 pt-2 border-t border-slate-100 dark:border-slate-700 space-y-1">
                                <button
                                  type="button"
                                  onClick={() => handleOpenCleaningModal({
                                    id: room.id,
                                    number: room.roomNumber,
                                    building: room.building,
                                    type: 'ROOM',
                                    category: room.type
                                  })}
                                  className={`w-full py-1.5 px-2 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 shadow-2xs cursor-pointer ${
                                    qc === 'PERLU_INSPEKSI'
                                      ? 'bg-teal-600 hover:bg-teal-700 text-white font-extrabold shadow-sm'
                                      : 'bg-slate-100 dark:bg-slate-700 hover:bg-teal-600 hover:text-white text-slate-700 dark:text-slate-200'
                                  }`}
                                >
                                  <i className="fa-solid fa-camera"></i>
                                  <span>{qc === 'PERLU_INSPEKSI' ? 'Buka Kamera / Selesai Bersih' : 'Re-Sterilisasi & Foto Baru'}</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })() : null}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-TAB 2: RUANG PERTEMUAN & AULA (SG)                                   */}
      {/* ========================================================================= */}
      {activeSubTab === 'RUANG_PERTEMUAN' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xs p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-700 pb-3">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 flex items-center justify-center font-bold">
                  <i className="fa-solid fa-landmark"></i>
                </div>
                <div>
                  <h3 className="font-black text-sm sm:text-base text-slate-900 dark:text-white">
                    Manajemen Sterilisasi Aula &amp; Gedung Serbaguna (SG)
                  </h3>
                  <p className="text-xs text-slate-500">
                    Pengecekan kebersihan dan sterilisasi panggung, kursi, sound system, dan toilet aula pasca acara.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {meetingRooms.map(mr => {
                const qc = mr.qcStatus || 'PERLU_INSPEKSI';
                const latestLog = getLatestCleaningLog(mr.id) || getLatestCleaningLog(mr.name);

                return (
                  <div
                    key={mr.id}
                    className={`rounded-2xl border p-4 flex flex-col justify-between transition-all shadow-2xs ${
                      qc === 'LOLOS_QC'
                        ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/20 dark:bg-emerald-950/10'
                        : qc === 'MENUNGGU_QC'
                        ? 'border-purple-300 dark:border-purple-800 bg-purple-50/30 dark:bg-purple-950/15 ring-1 ring-purple-300/40'
                        : 'border-amber-200 dark:border-amber-800 bg-amber-50/20 dark:bg-amber-950/10'
                    }`}
                  >
                    <div className="space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center space-x-2">
                          <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 flex items-center justify-center font-bold text-xs">
                            <i className="fa-solid fa-landmark"></i>
                          </div>
                          <div>
                            <h4 className="font-extrabold text-sm text-slate-900 dark:text-white">
                              {mr.name}
                            </h4>
                            <span className="text-[10px] text-slate-400">
                              Kapasitas: {mr.capacity} Orang • {mr.category || 'AULA'}
                            </span>
                          </div>
                        </div>

                        <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${
                          mr.status === 'TERPAKAI' ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'
                        }`}>
                          {mr.status}
                        </span>
                      </div>

                      {/* QC Badge */}
                      <div>
                        {qc === 'LOLOS_QC' ? (
                          <div className="px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center space-x-1.5">
                            <i className="fa-solid fa-circle-check text-emerald-600"></i>
                            <span>Lolos QC (Steril &amp; Siap Dipakai)</span>
                          </div>
                        ) : qc === 'MENUNGGU_QC' ? (
                          <div className="px-2 py-1 rounded-lg text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200 flex items-center space-x-1.5 animate-pulse">
                            <i className="fa-solid fa-bell text-purple-600"></i>
                            <span>Menunggu Verifikasi QC</span>
                          </div>
                        ) : (
                          <div className="px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200 flex items-center space-x-1.5">
                            <i className="fa-solid fa-triangle-exclamation text-amber-600"></i>
                            <span>Perlu Dibereskan &amp; Sterilisasi</span>
                          </div>
                        )}
                      </div>

                      {/* Log details */}
                      {latestLog ? (
                        <div className="bg-white/80 dark:bg-slate-900/80 p-2 rounded-xl border border-slate-200/80 dark:border-slate-700/80 space-y-1 text-[10px]">
                          <div className="flex items-center justify-between text-slate-500">
                            <span>Petugas:</span>
                            <span className="font-bold text-slate-800 dark:text-slate-200">{latestLog.petugasName}</span>
                          </div>
                          <div className="flex items-center justify-between text-slate-500">
                            <span>Waktu Real:</span>
                            <span className="font-mono text-slate-600 dark:text-slate-300 text-[9px]">{latestLog.timestamp}</span>
                          </div>
                          {latestLog.photoUrl && (
                            <div className="pt-1 flex items-center space-x-2">
                              <img 
                                src={latestLog.photoUrl} 
                                alt="Bukti Aula" 
                                className="w-10 h-10 object-cover rounded-lg border border-slate-200 shadow-2xs shrink-0 cursor-pointer hover:scale-105 transition"
                                onClick={() => setPreviewLightboxLog(latestLog)}
                                title="Klik untuk melihat bukti foto real ber-watermark waktu"
                              />
                              <button
                                type="button"
                                onClick={() => setPreviewLightboxLog(latestLog)}
                                className="text-teal-700 dark:text-teal-400 font-bold hover:underline cursor-pointer flex items-center space-x-1 text-[10px]"
                              >
                                <i className="fa-solid fa-camera text-[9px]"></i>
                                <span>Lihat Bukti Foto</span>
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="p-2 rounded-xl bg-slate-50 dark:bg-slate-900 text-center text-[10px] text-slate-400 italic">
                          Belum ada log foto sterilisasi aula
                        </div>
                      )}
                    </div>

                    <div className="mt-3 pt-2 border-t border-slate-100 dark:border-slate-700">
                      <button
                        type="button"
                        onClick={() => handleOpenCleaningModal({
                          id: mr.id,
                          number: mr.name,
                          building: mr.building || 'Ruang Pertemuan / Aula',
                          type: 'MEETING',
                          category: mr.category
                        })}
                        className="w-full py-2 px-3 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold transition flex items-center justify-center space-x-2 shadow-2xs cursor-pointer"
                      >
                        <i className="fa-solid fa-camera"></i>
                        <span>Buka Kamera / Selesai Bersih</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-TAB 3: DATABASE CRUD & LOG RIWAYAT PEMBERSIHAN                      */}
      {/* ========================================================================= */}
      {activeSubTab === 'DATABASE_CRUD' && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 sm:p-5 border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-700">
            <div>
              <h3 className="font-black text-sm sm:text-base text-slate-900 dark:text-white flex items-center space-x-2">
                <i className="fa-solid fa-database text-teal-600"></i>
                <span>Database Log Pembersihan &amp; Bukti Foto Petugas Gedung (CRUD)</span>
              </h3>
              <p className="text-xs text-slate-500">
                Arsip lengkap seluruh aktivitas pembersihan dengan foto real, watermark waktu otomatis, edit catatan, dan hapus data.
              </p>
            </div>

            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold px-3 py-1 rounded-xl bg-teal-50 dark:bg-teal-950 text-teal-800 dark:text-teal-300 border border-teal-200 dark:border-teal-800">
                Total Arsip: {cleaningLogs.length} Laporan
              </span>
            </div>
          </div>

          {/* TABLE OF LOGS */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-700 dark:text-slate-200">
              <thead className="bg-slate-100 dark:bg-slate-700/60 uppercase text-[10px] font-extrabold text-slate-500 dark:text-slate-400 tracking-wider">
                <tr>
                  <th className="p-3 rounded-l-xl">Waktu &amp; Tanggal Real</th>
                  <th className="p-3">Gedung &amp; Ruangan</th>
                  <th className="p-3">Petugas Pelaksana</th>
                  <th className="p-3">Bukti Foto Real (Watermark)</th>
                  <th className="p-3">Catatan Housekeeping</th>
                  <th className="p-3">Status QC</th>
                  <th className="p-3 text-right rounded-r-xl">Aksi (CRUD)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700 font-medium">
                {cleaningLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400 space-y-1.5">
                      <i className="fa-solid fa-folder-open text-3xl text-slate-300"></i>
                      <p className="font-bold text-slate-600 dark:text-slate-300 text-sm">Belum ada riwayat laporan pembersihan tersimpan</p>
                      <p className="text-[11px] text-slate-400">Gunakan tab Gedung Kamar atau Aula untuk mengambil foto kamera real dan mengirim laporan.</p>
                    </td>
                  </tr>
                ) : (
                  cleaningLogs.map(log => (
                    <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-750 transition">
                      <td className="p-3 font-mono text-slate-500 text-[11px] whitespace-nowrap">
                        <i className="fa-solid fa-clock mr-1 text-teal-600 text-[10px]"></i>
                        {log.timestamp}
                      </td>
                      <td className="p-3">
                        <div className="font-extrabold text-slate-900 dark:text-white flex items-center space-x-1.5">
                          <i className="fa-solid fa-hotel text-slate-400 text-xs"></i>
                          <span>{log.building} • {log.roomNumber}</span>
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center space-x-1.5">
                          <div className="w-6 h-6 rounded-full bg-teal-100 text-teal-800 flex items-center justify-center font-bold text-[10px]">
                            <i className="fa-solid fa-user"></i>
                          </div>
                          <span className="font-semibold text-slate-700 dark:text-slate-300">{log.petugasName}</span>
                        </div>
                      </td>
                      <td className="p-3">
                        {log.photoUrl ? (
                          <div className="flex items-center space-x-2">
                            <img 
                              src={log.photoUrl} 
                              alt="Bukti Foto" 
                              className="w-12 h-10 object-cover rounded-lg border border-slate-200 dark:border-slate-700 shadow-2xs shrink-0 cursor-pointer hover:scale-105 transition"
                              onClick={() => setPreviewLightboxLog(log)}
                              title="Klik untuk melihat bukti foto real ber-watermark waktu"
                            />
                            <button
                              type="button"
                              onClick={() => setPreviewLightboxLog(log)}
                              className="text-teal-700 dark:text-teal-400 font-bold hover:underline cursor-pointer flex items-center space-x-1 text-[11px]"
                            >
                              <i className="fa-solid fa-magnifying-glass-plus text-[10px]"></i>
                              <span>Perbesar</span>
                            </button>
                          </div>
                        ) : (
                          <span className="text-slate-400 italic text-[11px]">Tidak ada foto</span>
                        )}
                      </td>
                      <td className="p-3">
                        <div className="text-[11px] text-slate-600 dark:text-slate-300 max-w-xs truncate" title={log.notes}>
                          {log.notes || '-'}
                        </div>
                      </td>
                      <td className="p-3">
                        <span className={`px-2.5 py-0.5 rounded text-[10px] font-bold ${
                          log.status === 'LOLOS_QC'
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            : log.status === 'MENUNGGU_QC'
                            ? 'bg-purple-100 text-purple-800 border border-purple-200'
                            : 'bg-amber-100 text-amber-800 border border-amber-200'
                        }`}>
                          {log.status === 'LOLOS_QC' ? '✅ Lolos QC' : log.status === 'MENUNGGU_QC' ? '🔔 Menunggu QC' : '⚠️ Perlu Inspeksi'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end space-x-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenEditLog(log)}
                            className="p-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-bold transition cursor-pointer"
                            title="Edit Catatan / Status"
                          >
                            <i className="fa-solid fa-pen-to-square"></i>
                          </button>
                          <button
                            type="button"
                            onClick={() => setLogToDelete(log)}
                            className="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-xs font-bold transition cursor-pointer"
                            title="Hapus Laporan Pembersihan"
                          >
                            <i className="fa-solid fa-trash"></i>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: BUKTI FOTO KAMERA REAL & WATERMARK OTOMATIS                      */}
      {/* ========================================================================= */}
      {isCleaningModalOpen && targetItem && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-xl w-full overflow-hidden border border-slate-200 dark:border-slate-700 p-5 space-y-4 animate-in fade-in zoom-in duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center space-x-2.5">
                <div className="w-10 h-10 rounded-xl bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300 flex items-center justify-center font-bold">
                  <i className="fa-solid fa-camera"></i>
                </div>
                <div>
                  <h3 className="font-black text-sm text-slate-800 dark:text-white">
                    Bukti Foto Kamera Real &amp; Sterilisasi
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    {targetItem.building} • {targetItem.type === 'ROOM' ? `Kamar ${targetItem.number}` : targetItem.number}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsCleaningModalOpen(false);
                  setTargetItem(null);
                  setWatermarkedPhotoUrl(null);
                }}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200 flex items-center justify-center transition cursor-pointer"
              >
                <i className="fa-solid fa-xmark text-xs"></i>
              </button>
            </div>

            <form onSubmit={handleSubmitCleaningReport} className="space-y-4">
              {/* HIDDEN FILE INPUTS */}
              {/* Input 1: Direct Device Camera Capture */}
              <input 
                ref={cameraInputRef}
                type="file" 
                accept="image/*" 
                capture="environment"
                onChange={handleImageFileSelect}
                className="hidden" 
              />
              {/* Input 2: Device File / Folder Selector */}
              <input 
                ref={fileInputRef}
                type="file" 
                accept="image/*" 
                onChange={handleImageFileSelect}
                className="hidden" 
              />

              {/* ACTION BUTTONS TO ACCESS CAMERA OR FOLDER */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                  Ambil Bukti Foto Real (Otomatis Watermark Waktu &amp; Tanggal):
                </label>
                
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    className="py-3 px-4 bg-teal-600 hover:bg-teal-700 text-white rounded-xl font-bold text-xs shadow-md transition flex items-center justify-center space-x-2 cursor-pointer"
                  >
                    <i className="fa-solid fa-camera text-sm"></i>
                    <span>Buka Kamera Perangkat</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="py-3 px-4 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl font-bold text-xs border border-slate-200 dark:border-slate-700 transition flex items-center justify-center space-x-2 cursor-pointer"
                  >
                    <i className="fa-solid fa-folder-open text-sm text-teal-600"></i>
                    <span>Pilih dari Folder File</span>
                  </button>
                </div>
              </div>

              {/* WATERMARK PROCESSING SPINNER */}
              {isProcessingWatermark && (
                <div className="p-4 bg-teal-50 dark:bg-teal-950/40 rounded-xl border border-teal-200 dark:border-teal-800 flex items-center justify-center space-x-2 text-teal-800 dark:text-teal-300 text-xs font-bold animate-pulse">
                  <i className="fa-solid fa-circle-notch fa-spin"></i>
                  <span>Memproses foto dan menyematkan watermark waktu real...</span>
                </div>
              )}

              {/* PREVIEW OF REAL WATERMARKED PHOTO */}
              {watermarkedPhotoUrl && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-bold text-slate-500 block">
                    Hasil Foto Real Ber-Watermark:
                  </span>
                  <div className="relative rounded-xl overflow-hidden border-2 border-teal-600 shadow-md max-h-60 bg-black flex items-center justify-center">
                    <img 
                      src={watermarkedPhotoUrl} 
                      alt="Watermarked Preview" 
                      className="max-h-60 w-full object-contain"
                    />
                    <div className="absolute top-2 right-2 bg-emerald-600 text-white text-[10px] font-extrabold px-2.5 py-1 rounded-full shadow-md flex items-center space-x-1">
                      <i className="fa-solid fa-shield-check"></i>
                      <span>Watermark Real Aktif</span>
                    </div>
                  </div>
                </div>
              )}

              {/* CLEANING NOTES */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Catatan Pembersihan Housekeeping:
                </label>
                <textarea
                  value={cleaningNotes}
                  onChange={e => setCleaningNotes(e.target.value)}
                  rows={3}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-600 resize-none font-medium"
                  placeholder="Contoh: Penggantian sprei set baru, sanitasi kamar mandi, lantai dipel bersih, remote AC berfungsi..."
                ></textarea>
              </div>

              {/* INFO BOX */}
              <div className="bg-teal-50 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-800 rounded-xl p-3 text-[11px] text-teal-900 dark:text-teal-300 flex items-start space-x-2">
                <i className="fa-solid fa-circle-check text-teal-600 mt-0.5"></i>
                <div>
                  <span className="font-bold block">Watermark Tanggal &amp; Waktu Terverifikasi:</span>
                  Foto langsung dari kamera atau folder perangkat secara otomatis distempel waktu nyata (WIB), lokasi gedung, nomor kamar, dan identitas petugas {currentUser?.fullName || 'Petugas'}.
                </div>
              </div>

              {/* MODAL ACTION BUTTONS */}
              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setIsCleaningModalOpen(false);
                    setTargetItem(null);
                    setWatermarkedPhotoUrl(null);
                  }}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 font-bold rounded-xl text-xs transition cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={!watermarkedPhotoUrl || isProcessingWatermark}
                  className={`px-5 py-2.5 rounded-xl text-xs font-bold shadow-md transition flex items-center space-x-2 cursor-pointer ${
                    watermarkedPhotoUrl && !isProcessingWatermark
                      ? 'bg-teal-600 hover:bg-teal-700 text-white'
                      : 'bg-slate-300 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  <i className="fa-solid fa-paper-plane"></i>
                  <span>Kirim Laporan &amp; Minta Verifikasi QC</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: EDIT LAPORAN PEMBERSIHAN (CRUD UPDATE)                             */}
      {/* ========================================================================= */}
      {editingLog && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden border border-slate-200 dark:border-slate-700 p-5 space-y-4 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center space-x-2.5">
                <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center font-bold">
                  <i className="fa-solid fa-pen-to-square"></i>
                </div>
                <div>
                  <h3 className="font-bold text-sm text-slate-800 dark:text-white">
                    Edit Laporan Pembersihan (CRUD)
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    {editingLog.building} • {editingLog.roomNumber} ({editingLog.timestamp})
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingLog(null)}
                className="w-8 h-8 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 flex items-center justify-center transition cursor-pointer"
              >
                <i className="fa-solid fa-xmark text-xs"></i>
              </button>
            </div>

            <form onSubmit={handleSaveEditLog} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Catatan Housekeeping:
                </label>
                <textarea
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  rows={3}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-600 resize-none font-medium"
                ></textarea>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Status QC:
                </label>
                <select
                  value={editStatus}
                  onChange={e => setEditStatus(e.target.value as any)}
                  className="w-full p-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold text-slate-800 dark:text-slate-100 outline-none cursor-pointer"
                >
                  <option value="PERLU_INSPEKSI">⚠️ Perlu Inspeksi</option>
                  <option value="MENUNGGU_QC">🔔 Menunggu QC</option>
                  <option value="LOLOS_QC">✅ Lolos QC</option>
                </select>
              </div>

              {editingLog.photoUrl && (
                <div className="space-y-1">
                  <span className="text-[11px] font-bold text-slate-500">Bukti Foto:</span>
                  <img src={editingLog.photoUrl} alt="Bukti" className="w-full h-32 object-cover rounded-xl border border-slate-200" />
                </div>
              )}

              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingLog(null)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                >
                  <i className="fa-solid fa-save"></i>
                  <span>Simpan Perubahan</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: LIGHTBOX HIGH-RES FOTO WATERMARK (CRUD READ)                     */}
      {/* ========================================================================= */}
      {previewLightboxLog && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl max-w-3xl w-full overflow-hidden border border-slate-700 p-5 space-y-4 animate-in fade-in zoom-in duration-150 text-white">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="font-extrabold text-sm sm:text-base text-gold-300 flex items-center space-x-2">
                  <i className="fa-solid fa-camera"></i>
                  <span>Bukti Foto Real Sterilisasi &amp; Watermark Waktu</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {previewLightboxLog.building} • {previewLightboxLog.roomNumber} | Oleh {previewLightboxLog.petugasName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewLightboxLog(null)}
                className="w-8 h-8 rounded-full bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center transition cursor-pointer"
              >
                <i className="fa-solid fa-xmark text-sm"></i>
              </button>
            </div>

            <div className="rounded-xl overflow-hidden border border-slate-800 bg-black flex items-center justify-center max-h-[500px]">
              <img 
                src={previewLightboxLog.photoUrl} 
                alt="High-Res Bukti" 
                className="max-h-[500px] w-auto max-w-full object-contain"
              />
            </div>

            <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="space-y-0.5">
                <span className="font-bold text-gold-300 block">Catatan Petugas:</span>
                <p className="text-slate-300">{previewLightboxLog.notes || 'Pembersihan selesai sesuai standar.'}</p>
              </div>
              <div className="text-right shrink-0">
                <span className="text-[10px] text-slate-400 block">Waktu Tercatat:</span>
                <span className="font-mono font-bold text-emerald-400">{previewLightboxLog.timestamp}</span>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setPreviewLightboxLog(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-xl text-xs transition cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: KONFIRMASI HAPUS LOG PEMBERSIHAN (CRUD DELETE)                     */}
      {/* ========================================================================= */}
      {logToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200 dark:border-slate-700 p-5 space-y-4 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center space-x-3 text-rose-600">
              <div className="w-10 h-10 rounded-xl bg-rose-100 flex items-center justify-center font-bold">
                <i className="fa-solid fa-triangle-exclamation text-lg"></i>
              </div>
              <div>
                <h3 className="font-black text-sm text-slate-900 dark:text-white">
                  Konfirmasi Hapus Laporan
                </h3>
                <p className="text-[11px] text-slate-500">
                  Tindakan ini akan menghapus arsip foto dan log kebersihan secara permanen.
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300">
              Apakah Anda yakin ingin menghapus laporan pembersihan untuk <strong className="text-slate-900 dark:text-white">{logToDelete.building} {logToDelete.roomNumber}</strong> tanggal <strong className="font-mono">{logToDelete.timestamp}</strong>?
            </p>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setLogToDelete(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs transition shadow-md flex items-center space-x-1.5 cursor-pointer"
              >
                <i className="fa-solid fa-trash"></i>
                <span>Ya, Hapus Permanen</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
