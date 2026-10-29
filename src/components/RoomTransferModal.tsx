import React, { useState, useEffect, useMemo } from 'react';
import { useAppContext } from '../store';
import { Transaction, Room } from '../types';
import { useBodyScrollLock } from '../lib/scrollLock';
import { formatIndonesianDate, addDaysToDateStr, formatRupiah, getRealTodayDate } from '../lib/utils';

interface RoomTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  transaction: Transaction | null;
  room: Room | null;
}

export const RoomTransferModal: React.FC<RoomTransferModalProps> = ({
  isOpen,
  onClose,
  transaction,
  room,
}) => {
  useBodyScrollLock(isOpen);
  const { buildings, rooms, transferRoom, currentUser, showToast } = useAppContext();

  // Selected State
  const [selectedBuildingName, setSelectedBuildingName] = useState<string>('');
  const [selectedFloor, setSelectedFloor] = useState<number | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedTargetRoomId, setSelectedTargetRoomId] = useState<string>('');
  
  // Billing Policy State
  const [ratePolicy, setRatePolicy] = useState<'PERTAHANKAN_TARIF' | 'SESUAIKAN_TARIF'>('PERTAHANKAN_TARIF');
  
  // Transfer Reason & Notes
  const [reasonCategory, setReasonCategory] = useState<'KELUHAN_FASILITAS' | 'PERMINTAAN_TAMU' | 'UPGRADE_KAMAR' | 'KEBUTUHAN_OPERASIONAL' | 'LAINNYA'>('PERMINTAAN_TAMU');
  const [transferNotes, setTransferNotes] = useState<string>('');

  // Active source room resolving
  const sourceRoom = useMemo(() => {
    if (room) return room;
    if (transaction) {
      return rooms.find(r => r.id === transaction.roomId || (r.roomNumber === transaction.roomNumber && r.building === transaction.building)) || null;
    }
    return null;
  }, [room, transaction, rooms]);

  // Reset and initialize state on open
  useEffect(() => {
    if (isOpen) {
      const activeBld = sourceRoom?.building || (buildings.length > 0 ? buildings[0].name : '');
      setSelectedBuildingName(activeBld);
      setSelectedFloor('ALL');
      setSearchQuery('');
      setSelectedTargetRoomId('');
      setRatePolicy('PERTAHANKAN_TARIF');
      setReasonCategory('PERMINTAAN_TAMU');
      setTransferNotes('');
    }
  }, [isOpen, sourceRoom, buildings]);

  // Target Room Object
  const targetRoom = useMemo(() => {
    return rooms.find(r => r.id === selectedTargetRoomId) || null;
  }, [selectedTargetRoomId, rooms]);

  // Calculate remaining days for stay
  const remainingDays = useMemo(() => {
    if (!transaction) return 1;
    const realToday = getRealTodayDate();
    const start = new Date(transaction.startDate);
    const today = new Date(realToday);
    
    // Difference in calendar days from start
    const diffTime = today.getTime() - start.getTime();
    const daysElapsed = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
    const rem = Math.max(1, (transaction.duration || 1) - daysElapsed);
    return rem;
  }, [transaction]);

  // Pricing & Billing calculations
  const oldRate = sourceRoom?.pricePerNight || transaction?.pricePerNight || 0;
  const newRate = targetRoom?.pricePerNight || oldRate;
  const rateDiffPerNight = newRate - oldRate;
  const calculatedAdjustment = ratePolicy === 'SESUAIKAN_TARIF' ? rateDiffPerNight * remainingDays : 0;
  const previewTotalAmount = Math.max(0, (transaction?.totalAmount || 0) + calculatedAdjustment);

  // Available buildings for lodging (excluding meeting halls)
  const lodgingBuildings = useMemo(() => {
    return buildings.filter(b => b.status === 'AKTIF' && b.category !== 'SERBAGUNA' && b.category !== 'RUANG_PERTEMUAN');
  }, [buildings]);

  // Floors for the selected building
  const availableFloors = useMemo(() => {
    const bldRooms = rooms.filter(r => String(r.building || '').toLowerCase() === String(selectedBuildingName || '').toLowerCase());
    const floorsSet = new Set<number>();
    bldRooms.forEach(r => {
      if (r.floor) floorsSet.add(r.floor);
    });
    return Array.from(floorsSet).sort((a, b) => a - b);
  }, [rooms, selectedBuildingName]);

  // Semua kamar di gedung yang dipilih (dengan filter lantai & pencarian)
  const allRoomsInBuilding = useMemo(() => {
    return rooms.filter(r => {
      if (!r) return false;
      // Harus sesuai gedung terpilih
      if (String(r.building || '').toLowerCase() !== String(selectedBuildingName || '').toLowerCase()) return false;
      // Filter lantai jika dipilih
      if (selectedFloor !== 'ALL' && (r.floor || 1) !== selectedFloor) return false;
      // Pencarian nomor kamar / tipe / bed / status
      if (searchQuery && String(searchQuery).trim()) {
        const q = String(searchQuery).toLowerCase().trim();
        const matchesNum = String(r.roomNumber || '').toLowerCase().includes(q);
        const matchesType = String(r.type || '').toLowerCase().includes(q);
        const matchesBed = String(r.bedType || '').toLowerCase().includes(q);
        const matchesStatus = String(r.status || '').toLowerCase().includes(q);
        if (!matchesNum && !matchesType && !matchesBed && !matchesStatus) return false;
      }
      return true;
    }).sort((a, b) => {
      const flA = a.floor || 1;
      const flB = b.floor || 1;
      if (flA !== flB) return flA - flB;
      return String(a.roomNumber || '').localeCompare(String(b.roomNumber || ''), undefined, { numeric: true });
    });
  }, [rooms, selectedBuildingName, selectedFloor, searchQuery]);

  // Hitung jumlah kamar Ready yang siap dihuni di gedung terpilih
  const readyRoomsInBuilding = useMemo(() => {
    return allRoomsInBuilding.filter(r => {
      const isSource = sourceRoom && (r.id === sourceRoom.id || r.roomNumber === sourceRoom.roomNumber);
      return (r.status === 'READY' || r.status === 'KOSONG') && !isSource;
    });
  }, [allRoomsInBuilding, sourceRoom]);

  // Statistik kamar per gedung untuk badge tab (Ready & Total)
  const roomCountByBuilding = useMemo(() => {
    const map: Record<string, { ready: number; total: number }> = {};
    lodgingBuildings.forEach(b => {
      const bRooms = rooms.filter(r => String(r.building || '').toLowerCase() === String(b.name || '').toLowerCase());
      const readyCount = bRooms.filter(r => 
        (r.status === 'READY' || r.status === 'KOSONG') &&
        (!sourceRoom || r.id !== sourceRoom.id)
      ).length;
      map[String(b.name || '').toLowerCase()] = { ready: readyCount, total: bRooms.length };
    });
    return map;
  }, [lodgingBuildings, rooms, sourceRoom]);

  if (!isOpen || !transaction) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetRoom) {
      showToast('Silakan pilih kamar tujuan dari denah kamar yang tersedia!', 'warning');
      return;
    }

    const isTargetReady = targetRoom.status === 'READY' || targetRoom.status === 'KOSONG';
    if (!isTargetReady) {
      showToast(`Kamar ${targetRoom.roomNumber} saat ini tidak berstatus Ready (${targetRoom.status}). Hanya kamar berstatus Ready yang dapat dipilih!`, 'error');
      return;
    }

    if (sourceRoom && (targetRoom.id === sourceRoom.id || targetRoom.roomNumber === sourceRoom.roomNumber)) {
      showToast(`Kamar ${targetRoom.roomNumber} adalah kamar asal tamu saat ini. Silakan pilih kamar tujuan lain!`, 'error');
      return;
    }

    const success = transferRoom(transaction.id, targetRoom.id, {
      reasonCategory,
      notes: transferNotes.trim(),
      ratePolicy,
      rateAdjustmentTotal: calculatedAdjustment,
      newPricePerNight: newRate,
      remainingDays,
    });

    if (success) {
      onClose();
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-2 sm:p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div 
        className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full overflow-hidden border border-slate-200 flex flex-col max-h-[92vh] my-auto animate-in fade-in zoom-in duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div className="bg-gradient-to-r from-hajj-800 via-hajj-900 to-slate-900 px-4 sm:px-6 py-3.5 text-white flex items-center justify-between shrink-0 shadow-sm">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gold-400/20 border border-gold-300/30 flex items-center justify-center text-gold-300 shadow-inner">
              <i className="fa-solid fa-right-left text-base sm:text-lg"></i>
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="font-bold text-sm sm:text-base text-white tracking-wide">
                  Mutasi &amp; Pindah Kamar Tamu
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gold-400 text-hajj-950 uppercase">
                  SOP Terpadu
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-hajj-200 mt-0.5">
                Pemindahan tamu antar kamar atau antar gedung dengan penyesuaian tarif, denah interaktif, dan status inspeksi kebersihan.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition cursor-pointer"
          >
            <i className="fa-solid fa-xmark text-sm"></i>
          </button>
        </div>

        {/* BODY */}
        <form onSubmit={handleSubmit} className="p-4 sm:p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1 bg-slate-50/60">
          
          {/* SECTION 1: RINGKASAN TAMU & KAMAR ASAL */}
          <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 shadow-2xs space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
              <div className="flex items-center space-x-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="font-bold text-xs sm:text-sm text-slate-800">
                  {transaction.guestName}
                </span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                  {transaction.category === 'JEMAAH' ? `Jemaah Haji (${transaction.kloter || '-'})` : 'Tamu Umum'}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 flex items-center space-x-3">
                <span><i className="fa-solid fa-phone text-slate-400 mr-1"></i>{transaction.phone || '-'}</span>
                <span><i className="fa-solid fa-receipt text-slate-400 mr-1"></i>ID: {transaction.id}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                <span className="text-[10px] text-slate-400 block font-medium">Gedung &amp; Kamar Asal:</span>
                <span className="font-bold text-slate-800 block truncate">
                  {sourceRoom ? `${sourceRoom.building} • Kamar ${sourceRoom.roomNumber}` : `${transaction.building} • ${transaction.roomNumber}`}
                </span>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                <span className="text-[10px] text-slate-400 block font-medium">Tipe &amp; Bed Asal:</span>
                <span className="font-bold text-slate-800 block truncate">
                  {sourceRoom?.type || 'Standar'} • {sourceRoom?.bedType || '4 Single Bed'}
                </span>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                <span className="text-[10px] text-slate-400 block font-medium">Tarif Lama / Malam:</span>
                <span className="font-bold text-slate-800 font-mono block">
                  {formatRupiah(oldRate)}
                </span>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                <span className="text-[10px] text-slate-400 block font-medium">Sisa Durasi Menginap:</span>
                <span className="font-bold text-hajj-800 block">
                  {remainingDays} Malam (Selesai {formatIndonesianDate(addDaysToDateStr(transaction.startDate, transaction.duration))})
                </span>
              </div>
            </div>
          </div>

          {/* SECTION 2: PEMILIHAN GEDUNG & DENAH KAMAR TUJUAN (SEMUA KAMAR TERLIHAT, NON-READY DIBLOKIR) */}
          <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 shadow-2xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center space-x-2">
                <span className="w-6 h-6 rounded-lg bg-hajj-100 text-hajj-800 flex items-center justify-center text-xs font-bold">
                  1
                </span>
                <h4 className="font-bold text-xs sm:text-sm text-slate-800">
                  Denah Pemilihan Kamar &amp; Gedung Tujuan
                </h4>
              </div>
              <span className="text-[11px] text-slate-500">
                Tersedia <strong className="text-emerald-700">{readyRoomsInBuilding.length}</strong> unit Ready dari total <strong>{allRoomsInBuilding.length}</strong> kamar
              </span>
            </div>

            {/* TAB PILIH GEDUNG */}
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1.5 uppercase tracking-wider">
                Gedung Penginapan:
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {lodgingBuildings.map(b => {
                  const isSelected = selectedBuildingName.toLowerCase() === b.name.toLowerCase();
                  const stats = roomCountByBuilding[b.name.toLowerCase()] || { ready: 0, total: 0 };
                  return (
                    <button
                      key={b.id || b.name}
                      type="button"
                      onClick={() => {
                        setSelectedBuildingName(b.name);
                        setSelectedFloor('ALL');
                        setSelectedTargetRoomId('');
                      }}
                      className={`p-2.5 rounded-xl border text-left transition cursor-pointer flex flex-col justify-between ${
                        isSelected 
                          ? 'bg-hajj-800 text-white border-hajj-900 shadow-md ring-2 ring-gold-400' 
                          : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold truncate">{b.name}</span>
                        <i className={`fa-solid fa-hotel text-xs ${isSelected ? 'text-gold-300' : 'text-slate-400'}`}></i>
                      </div>
                      <div className="flex items-center justify-between mt-2 pt-1 border-t border-white/10">
                        <span className={`text-[10px] ${isSelected ? 'text-hajj-200' : 'text-slate-400'}`}>
                          {b.floors || 3} Lantai
                        </span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded-full ${
                          stats.ready > 0 
                            ? (isSelected ? 'bg-gold-400 text-hajj-950' : 'bg-emerald-100 text-emerald-800')
                            : (isSelected ? 'bg-red-500/40 text-red-100' : 'bg-slate-100 text-slate-400')
                        }`}>
                          {stats.ready} Ready / {stats.total} Unit
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* FILTER LANTAI & CARI NOMOR KAMAR */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              {/* Floor Buttons */}
              <div className="flex items-center space-x-1 overflow-x-auto py-1">
                <span className="text-[11px] font-bold text-slate-500 mr-1 shrink-0">Lantai:</span>
                <button
                  type="button"
                  onClick={() => setSelectedFloor('ALL')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition cursor-pointer shrink-0 ${
                    selectedFloor === 'ALL'
                      ? 'bg-slate-800 text-white shadow-2xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Semua Lantai
                </button>
                {availableFloors.map(fl => (
                  <button
                    key={fl}
                    type="button"
                    onClick={() => setSelectedFloor(fl)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition cursor-pointer shrink-0 ${
                      selectedFloor === fl
                        ? 'bg-slate-800 text-white shadow-2xs'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    Lt. {fl}
                  </button>
                ))}
              </div>

              {/* Search Box */}
              <div className="relative w-full sm:w-56">
                <i className="fa-solid fa-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                <input
                  type="text"
                  placeholder="Cari no. kamar / status / tipe..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-hajj-700"
                />
              </div>
            </div>

            {/* GRID DENAH SEMUA KAMAR (Kamar tidak ready ditampilkan diblokir/disabled) */}
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50/50 max-h-64 overflow-y-auto custom-scrollbar">
              {allRoomsInBuilding.length === 0 ? (
                <div className="py-8 text-center text-slate-400 space-y-1.5">
                  <i className="fa-solid fa-door-closed text-2xl text-slate-300"></i>
                  <p className="text-xs font-semibold text-slate-600">Tidak ada kamar ditemukan pada lantai/pencarian ini</p>
                  <p className="text-[11px] text-slate-400">
                    Silakan ganti lantai atau kata kunci pencarian nomor kamar.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                  {allRoomsInBuilding.map(r => {
                    const isSource = sourceRoom && (r.id === sourceRoom.id || r.roomNumber === sourceRoom.roomNumber);
                    const isReady = (r.status === 'READY' || r.status === 'KOSONG') && !isSource;
                    const isSelected = selectedTargetRoomId === r.id;
                    const isTerisi = r.status === 'TERISI';
                    const isBooked = r.status === 'BOOKED';
                    const isMaintenance = r.status === 'MAINTENANCE';
                    const isClosed = r.status === 'CLOSED' || r.status === 'TIDAK_READY';

                    let blockBadge = null;
                    let blockReason = '';
                    if (isSource) {
                      blockBadge = (
                        <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-blue-100 text-blue-900 border border-blue-200 flex items-center gap-1">
                          <i className="fa-solid fa-user-check text-[8px]"></i>
                          <span>Kamar Asal</span>
                        </span>
                      );
                      blockReason = 'Ini adalah kamar asal tamu saat ini';
                    } else if (isTerisi) {
                      blockBadge = (
                        <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-rose-100 text-rose-800 border border-rose-200 flex items-center gap-1">
                          <i className="fa-solid fa-user-group text-[8px]"></i>
                          <span>Sedang Terisi</span>
                        </span>
                      );
                      blockReason = 'Kamar sedang ditempati tamu menginap';
                    } else if (isBooked) {
                      blockBadge = (
                        <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-blue-100 text-blue-800 border border-blue-200 flex items-center gap-1">
                          <i className="fa-solid fa-calendar-check text-[8px]"></i>
                          <span>Di-Booking</span>
                        </span>
                      );
                      blockReason = 'Kamar sudah di-booking tamu lain';
                    } else if (isMaintenance) {
                      blockBadge = (
                        <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 border border-amber-200 flex items-center gap-1">
                          <i className="fa-solid fa-wrench text-[8px]"></i>
                          <span>Maintenance</span>
                        </span>
                      );
                      blockReason = 'Kamar dalam perbaikan sarana teknisi';
                    } else if (isClosed) {
                      blockBadge = (
                        <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-slate-200 text-slate-800 border border-slate-300 flex items-center gap-1">
                          <i className="fa-solid fa-lock text-[8px]"></i>
                          <span>Closed (Tidak Ready)</span>
                        </span>
                      );
                      blockReason = 'Kamar sedang ditutup sementara (Hold)';
                    }

                    return (
                      <div
                        key={r.id}
                        onClick={() => {
                          if (!isReady) {
                            showToast(`Kamar ${r.roomNumber} tidak dapat dipilih (${blockReason})`, 'warning');
                            return;
                          }
                          setSelectedTargetRoomId(r.id);
                        }}
                        className={`p-3 rounded-xl border transition relative flex flex-col justify-between ${
                          isReady
                            ? (isSelected
                                ? 'bg-emerald-50/95 border-emerald-500 shadow-md ring-2 ring-emerald-500 cursor-pointer'
                                : 'bg-white hover:bg-emerald-50/30 border-slate-200 hover:border-emerald-300 shadow-2xs cursor-pointer')
                            : 'bg-slate-100/90 border-slate-200/90 opacity-60 cursor-not-allowed select-none'
                        }`}
                        title={isReady ? `Pilih Kamar ${r.roomNumber}` : `Kamar ${r.roomNumber} tidak dapat dipilih: ${blockReason}`}
                      >
                        {isSelected && isReady && (
                          <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center text-[10px] shadow-xs">
                            <i className="fa-solid fa-check"></i>
                          </div>
                        )}

                        <div>
                          <div className="flex items-center justify-between pr-5">
                            <span className={`font-extrabold text-sm tracking-tight ${isReady ? 'text-slate-900' : 'text-slate-500'}`}>
                              Kamar {r.roomNumber}
                            </span>
                            <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded ${
                              r.type === 'Superior' ? 'bg-purple-100 text-purple-800' :
                              r.type === 'Ekonomi' ? 'bg-teal-100 text-teal-800' :
                              'bg-blue-100 text-blue-800'
                            }`}>
                              {r.type || 'Standar'}
                            </span>
                          </div>

                          <div className="text-[11px] text-slate-600 mt-1 space-y-0.5">
                            <div className="flex items-center space-x-1.5 text-slate-500 text-[10px]">
                              <span>Lt. {r.floor || 1}</span>
                              <span>•</span>
                              <span>{r.bedType || '4 Single Bed'}</span>
                              <span>•</span>
                              <span>{r.capacity || '4 Orang'}</span>
                            </div>
                            <div className={`font-bold font-mono text-xs pt-0.5 ${isReady ? 'text-emerald-700' : 'text-slate-400'}`}>
                              {formatRupiah(r.pricePerNight || 0)} <span className="text-[10px] text-slate-400 font-normal">/ malam</span>
                            </div>
                          </div>
                        </div>

                        <div className="mt-2 pt-1.5 border-t border-slate-200/60 flex items-center justify-between text-[10px]">
                          {isReady ? (
                            <>
                              <span className="text-emerald-700 font-bold flex items-center">
                                <i className="fa-solid fa-circle-check text-[9px] mr-1"></i> Ready (Siap Huni)
                              </span>
                              <span className={`font-bold ${isSelected ? 'text-emerald-700' : 'text-emerald-600 underline'}`}>
                                {isSelected ? 'Terpilih' : 'Pilih Kamar'}
                              </span>
                            </>
                          ) : (
                            <>
                              {blockBadge}
                              <span className="text-slate-400 font-semibold italic flex items-center gap-1 text-[9px]">
                                <i className="fa-solid fa-ban text-[8px]"></i> Diblokir
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* SECTION 3: PENYESUAIAN TARIF & BILLING POLICY */}
          {targetRoom && (
            <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 shadow-2xs space-y-3">
              <div className="flex items-center space-x-2 border-b border-slate-100 pb-2">
                <span className="w-6 h-6 rounded-lg bg-hajj-100 text-hajj-800 flex items-center justify-center text-xs font-bold">
                  2
                </span>
                <h4 className="font-bold text-xs sm:text-sm text-slate-800">
                  Kebijakan Tarif &amp; Penyesuaian Biaya
                </h4>
              </div>

              {/* Komparasi Kamar Asal vs Kamar Baru */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Kamar Asal:</span>
                  <div className="font-bold text-slate-800">{sourceRoom?.building || transaction.building} - Kamar {sourceRoom?.roomNumber || transaction.roomNumber}</div>
                  <div className="text-[11px] text-slate-500">
                    Tipe: {sourceRoom?.type || 'Standar'} ({sourceRoom?.bedType || '4 Single Bed'})
                  </div>
                  <div className="text-xs font-bold text-slate-700 font-mono">
                    Tarif: {formatRupiah(oldRate)} / malam
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-emerald-50/70 border border-emerald-200 space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800 block">Kamar Baru Tujuan:</span>
                  <div className="font-bold text-emerald-950">{targetRoom.building} - Kamar {targetRoom.roomNumber}</div>
                  <div className="text-[11px] text-emerald-700">
                    Tipe: {targetRoom.type} ({targetRoom.bedType || 'Double Bed'})
                  </div>
                  <div className="text-xs font-bold text-emerald-800 font-mono">
                    Tarif: {formatRupiah(newRate)} / malam
                  </div>
                </div>
              </div>

              {/* Radio Saklar Kebijakan Tarif */}
              <div className="space-y-2 pt-1">
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                  Pilih Skema Pembebanan Biaya:
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label 
                    onClick={() => setRatePolicy('PERTAHANKAN_TARIF')}
                    className={`p-3 rounded-xl border text-left cursor-pointer transition flex items-start space-x-2.5 ${
                      ratePolicy === 'PERTAHANKAN_TARIF'
                        ? 'bg-blue-50/80 border-blue-500 ring-1 ring-blue-500'
                        : 'bg-white hover:bg-slate-50 border-slate-200'
                    }`}
                  >
                    <input
                      type="radio"
                      name="ratePolicy"
                      checked={ratePolicy === 'PERTAHANKAN_TARIF'}
                      onChange={() => setRatePolicy('PERTAHANKAN_TARIF')}
                      className="mt-0.5 text-blue-600 focus:ring-blue-500"
                    />
                    <div>
                      <span className="font-bold text-xs text-slate-900 block">
                        Pertahankan Tarif Awal (Bebas Biaya)
                      </span>
                      <span className="text-[10px] text-slate-500 mt-0.5 block leading-relaxed">
                        Tagihan tamu tidak berubah. Direkomendasikan jika pindah karena kendala fasilitas rusak atau kompensasi operasional.
                      </span>
                      <span className="text-[10px] font-bold text-emerald-700 mt-1 inline-block">
                        Biaya Tambahan: Rp 0
                      </span>
                    </div>
                  </label>

                  <label 
                    onClick={() => setRatePolicy('SESUAIKAN_TARIF')}
                    className={`p-3 rounded-xl border text-left cursor-pointer transition flex items-start space-x-2.5 ${
                      ratePolicy === 'SESUAIKAN_TARIF'
                        ? 'bg-amber-50/80 border-amber-500 ring-1 ring-amber-500'
                        : 'bg-white hover:bg-slate-50 border-slate-200'
                    }`}
                  >
                    <input
                      type="radio"
                      name="ratePolicy"
                      checked={ratePolicy === 'SESUAIKAN_TARIF'}
                      onChange={() => setRatePolicy('SESUAIKAN_TARIF')}
                      className="mt-0.5 text-amber-600 focus:ring-amber-500"
                    />
                    <div>
                      <span className="font-bold text-xs text-slate-900 block">
                        Sesuaikan Tarif Baru (Hitung Sisa Hari)
                      </span>
                      <span className="text-[10px] text-slate-500 mt-0.5 block leading-relaxed">
                        Menghitung selisih tarif per malam dikalikan {remainingDays} malam sisa hari menginap tamu.
                      </span>
                      <span className="text-[10px] font-bold text-amber-900 mt-1 inline-block">
                        {rateDiffPerNight >= 0 
                          ? `Penyesuaian: +${formatRupiah(calculatedAdjustment)}` 
                          : `Penyesuaian: ${formatRupiah(calculatedAdjustment)}`}
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Rincian Kalkulasi Transparan */}
              {ratePolicy === 'SESUAIKAN_TARIF' && rateDiffPerNight !== 0 && (
                <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-3 text-xs space-y-1.5 text-amber-950">
                  <div className="flex justify-between font-medium">
                    <span>Selisih Tarif per Malam:</span>
                    <span className="font-mono font-bold">
                      {rateDiffPerNight >= 0 ? `+${formatRupiah(rateDiffPerNight)}` : formatRupiah(rateDiffPerNight)}
                    </span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>Sisa Hari Menginap:</span>
                    <span>{remainingDays} Malam</span>
                  </div>
                  <div className="flex justify-between font-bold border-t border-amber-200 pt-1 text-sm text-amber-900">
                    <span>Total Penyesuaian Tagihan:</span>
                    <span className="font-mono">
                      {calculatedAdjustment >= 0 ? `+${formatRupiah(calculatedAdjustment)}` : formatRupiah(calculatedAdjustment)}
                    </span>
                  </div>
                  <p className="text-[10px] text-amber-800 italic pt-0.5">
                    * Tagihan / invoice tamu akan otomatis disesuaikan secara akurat ke database sistem.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* SECTION 4: ALASAN PEMINDAHAN & CATATAN AUDIT TRAIL */}
          <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 shadow-2xs space-y-3">
            <div className="flex items-center space-x-2 border-b border-slate-100 pb-2">
              <span className="w-6 h-6 rounded-lg bg-hajj-100 text-hajj-800 flex items-center justify-center text-xs font-bold">
                3
              </span>
              <h4 className="font-bold text-xs sm:text-sm text-slate-800">
                Alasan Mutasi &amp; Catatan Petugas (Audit Trail)
              </h4>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Kategori Alasan Pindah: <span className="text-red-500">*</span>
                </label>
                <select
                  value={reasonCategory}
                  onChange={(e) => setReasonCategory(e.target.value as any)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-hajj-600"
                >
                  <option value="KELUHAN_FASILITAS">Keluhan Kerusakan Fasilitas (AC / Air / Listrik)</option>
                  <option value="PERMINTAAN_TAMU">Permintaan Khusus Tamu (Ingin Lantai Bawah / Dekat Rombongan)</option>
                  <option value="UPGRADE_KAMAR">Upgrade / Pindah ke Tipe Kamar Lebih Luas</option>
                  <option value="KEBUTUHAN_OPERASIONAL">Kebutuhan Operasional &amp; Manajemen Asrama</option>
                  <option value="LAINNYA">Alasan Lainnya</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Petugas Pemroses:
                </label>
                <input
                  type="text"
                  readOnly
                  value={`${currentUser?.fullName || 'Petugas'} (${currentUser?.role || 'Resepsionis'})`}
                  className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-xs text-slate-600 font-medium cursor-not-allowed"
                />
              </div>

              <div className="col-span-1 sm:col-span-2">
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Catatan Keterangan Tambahan (Opsional):
                </label>
                <textarea
                  value={transferNotes}
                  onChange={(e) => setTransferNotes(e.target.value)}
                  rows={2}
                  placeholder="Contoh: Tamu lansia meminta pindah ke lantai dasar dekat lift..."
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-hajj-600 resize-none"
                ></textarea>
              </div>
            </div>

            {/* SOP Housekeeping Notice */}
            <div className="bg-teal-50 border border-teal-200 rounded-xl p-3 text-[11px] text-teal-900 flex items-start space-x-2.5">
              <i className="fa-solid fa-broom text-teal-700 text-sm mt-0.5"></i>
              <div>
                <span className="font-bold block text-teal-950">SOP Pembersihan Kamar Asal:</span>
                Kamar lama ({sourceRoom ? `${sourceRoom.building} ${sourceRoom.roomNumber}` : transaction.roomNumber}) akan otomatis dikosongkan dan ditandai berstatus <strong>"PERLU_INSPEKSI"</strong> (Perlu Pembersihan &amp; Cek QC) agar tim housekeeping dan penilai mutu segera merapikan kamar sebelum dihuni kembali.
              </div>
            </div>
          </div>

          {/* FOOTER ACTIONS */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-200">
            <div className="text-[11px] text-slate-500">
              {targetRoom ? (
                <span>Kamar Tujuan: <strong className="text-emerald-700">{targetRoom.building} - Kamar {targetRoom.roomNumber}</strong></span>
              ) : (
                <span className="text-amber-600 font-medium">Belum ada kamar tujuan yang dipilih</span>
              )}
            </div>

            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={!targetRoom}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded-xl text-xs shadow-md transition flex items-center space-x-2 cursor-pointer"
              >
                <i className="fa-solid fa-right-left"></i>
                <span>Konfirmasi Mutasi Kamar</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
