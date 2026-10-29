import React, { useState } from 'react';
import { useAppContext } from '../store';

export function AivenDatabaseView() {
  const { 
    currentUser, 
    showToast, 
    buildings = [], 
    rooms = [], 
    meetingRooms = [], 
    roomCapacityRates = [],
    breakfastMenuItems = [],
    breakfastOrders = [],
    transactions = [], 
    users = [], 
    maintenances = [], 
    qcInspections = [],
    workSessions = [],
    auditLogs = [],
    manualSyncSupabase,
    pushAllToSupabase,
    supabaseSyncState
  } = useAppContext();

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; time?: string } | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [selectedTable, setSelectedTable] = useState<string>('kamar');

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/pg/test');
      const data = await res.json();
      if (res.ok && data.success) {
        setTestResult({
          success: true,
          message: 'Koneksi ke Aiven PostgreSQL berhasil terhubung dengan aman (SSL Active).',
          time: data.time || new Date().toISOString()
        });
        showToast('Koneksi ke Aiven PostgreSQL berhasil!', 'success');
      } else {
        setTestResult({
          success: false,
          message: data.error || 'Gagal terhubung ke database Aiven PostgreSQL.'
        });
        showToast(data.error || 'Koneksi Aiven gagal.', 'error');
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err?.message || 'Gagal menghubungi backend proxy PostgreSQL.'
      });
      showToast('Gagal menghubungi backend PostgreSQL.', 'error');
    } finally {
      setIsTesting(false);
    }
  };

  const handlePullData = async () => {
    setIsPulling(true);
    try {
      await manualSyncSupabase();
      showToast('Data terbaru berhasil disinkronkan dari Aiven PostgreSQL!', 'success');
    } catch (err: any) {
      showToast(`Gagal menarik data: ${err?.message || 'Error'}`, 'error');
    } finally {
      setIsPulling(false);
    }
  };

  const handlePushData = async () => {
    setIsPushing(true);
    try {
      await pushAllToSupabase();
      showToast('Seluruh data berhasil disimpan ke Aiven PostgreSQL!', 'success');
    } catch (err: any) {
      showToast(`Gagal menyimpan data: ${err?.message || 'Error'}`, 'error');
    } finally {
      setIsPushing(false);
    }
  };

  const TABLE_MODULES = [
    { id: 'kamar', name: 'kamar', label: 'Kamar & Penginapan', count: rooms.length, icon: 'fa-bed' },
    { id: 'gedung', name: 'gedung', label: 'Master Gedung', count: buildings.length, icon: 'fa-building' },
    { id: 'transaksi', name: 'transaksi', label: 'Transaksi & Reservasi', count: transactions.length, icon: 'fa-receipt' },
    { id: 'users', name: 'users', label: 'Petugas & Anggota', count: users.length, icon: 'fa-users' },
    { id: 'maintenances', name: 'maintenances', label: 'Laporan Perbaikan & Fasilitas', count: maintenances.length, icon: 'fa-wrench' },
    { id: 'qc_inspections', name: 'qc_inspections', label: 'Inspeksi Quality Control', count: qcInspections.length, icon: 'fa-clipboard-check' },
    { id: 'work_sessions', name: 'work_sessions', label: 'Sesi & Kehadiran Petugas', count: workSessions.length, icon: 'fa-user-clock' },
    { id: 'meeting_rooms', name: 'meeting_rooms', label: 'Ruang Rapat & Fasilitas', count: meetingRooms.length, icon: 'fa-handshake' },
    { id: 'breakfast_orders', name: 'breakfast_orders', label: 'Pesanan Makan & Konsumsi', count: breakfastOrders.length, icon: 'fa-utensils' },
    { id: 'room_capacity_rates', name: 'room_capacity_rates', label: 'Tarif & Kapasitas Kamar', count: roomCapacityRates.length, icon: 'fa-tags' },
    { id: 'breakfast_menu_items', name: 'breakfast_menu_items', label: 'Katalog Menu Katering', count: breakfastMenuItems.length, icon: 'fa-bowl-food' },
    { id: 'audit_logs', name: 'audit_logs', label: 'Log Audit & Aktivitas Sistem', count: auditLogs.length, icon: 'fa-shield-halved' }
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Banner Utama Koneksi Aiven PostgreSQL */}
      <div className="bg-gradient-to-r from-slate-900 via-emerald-950 to-slate-900 text-white p-6 sm:p-7 rounded-2xl shadow-xl border border-emerald-500/30 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
          <i className="fa-solid fa-database text-9xl text-emerald-400"></i>
        </div>

        <div className="relative z-10 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="max-w-2xl space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center space-x-1.5 bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 px-3 py-1 rounded-full text-xs font-bold">
                  <i className="fa-solid fa-server"></i>
                  <span>Aiven Managed Cloud</span>
                </span>
                <span className="inline-flex items-center space-x-1.5 bg-sky-500/20 text-sky-300 border border-sky-400/30 px-3 py-1 rounded-full text-xs font-bold">
                  <i className="fa-solid fa-lock"></i>
                  <span>SSL/TLS Enkripsi Aktif</span>
                </span>
                <span className="inline-flex items-center space-x-1.5 bg-purple-500/20 text-purple-300 border border-purple-400/30 px-3 py-1 rounded-full text-xs font-bold">
                  <i className="fa-solid fa-bolt"></i>
                  <span>Driver node-postgres (pg Pool)</span>
                </span>
              </div>

              <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white flex items-center gap-2.5">
                <i className="fa-solid fa-database text-emerald-400"></i>
                Basis Data Utama Aiven PostgreSQL
              </h2>
              <p className="text-xs text-slate-300 leading-relaxed">
                SIM Asrama Haji terhubung langsung dengan basis data <strong>Aiven PostgreSQL</strong>. Seluruh modul reservasi jemaah, ketersediaan kamar, transaksi, akun, dan rekap operasional tersimpan secara transaksional dengan perlindungan data cloud tingkat enterprise.
              </p>
            </div>

            {/* Tombol Aksi Utama */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting}
                className="px-4 py-2.5 bg-white/10 hover:bg-white/20 text-white border border-white/20 font-bold text-xs rounded-xl transition flex items-center space-x-2 shadow-sm cursor-pointer disabled:opacity-50"
              >
                <i className={`fa-solid ${isTesting ? 'fa-spinner fa-spin' : 'fa-network-wired text-sky-400'}`}></i>
                <span>{isTesting ? 'Menguji...' : 'Uji Koneksi Aiven'}</span>
              </button>

              <button
                type="button"
                onClick={handlePullData}
                disabled={isPulling}
                className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl transition flex items-center space-x-2 shadow-sm cursor-pointer disabled:opacity-50"
              >
                <i className={`fa-solid ${isPulling ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-down'}`}></i>
                <span>{isPulling ? 'Menarik...' : 'Tarik Data Aiven'}</span>
              </button>

              <button
                type="button"
                onClick={handlePushData}
                disabled={isPushing}
                className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs rounded-xl transition flex items-center space-x-2 shadow-sm cursor-pointer disabled:opacity-50"
              >
                <i className={`fa-solid ${isPushing ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'}`}></i>
                <span>{isPushing ? 'Menyimpan...' : 'Kirim Pembaruan'}</span>
              </button>
            </div>
          </div>

          {/* Test Result Alert */}
          {testResult && (
            <div className={`p-3 rounded-xl border text-xs flex items-center space-x-2.5 ${
              testResult.success 
                ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-200' 
                : 'bg-red-950/80 border-red-500/50 text-red-200'
            }`}>
              <i className={`fa-solid ${testResult.success ? 'fa-circle-check text-emerald-400' : 'fa-triangle-exclamation text-red-400'} text-base`}></i>
              <div className="flex-1">
                <span className="font-bold">{testResult.message}</span>
                {testResult.time && (
                  <span className="block text-[11px] opacity-80 mt-0.5">Waktu respon server: {testResult.time}</span>
                )}
              </div>
            </div>
          )}

          {/* Metadata Koneksi */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-3 border-t border-white/10 text-xs">
            <div className="bg-black/30 px-3.5 py-2 rounded-xl border border-white/10 flex items-center justify-between">
              <span className="text-slate-400 text-[11px]">Database Provider:</span>
              <span className="font-mono text-emerald-300 font-bold text-[11px]">Aiven Cloud PostgreSQL</span>
            </div>
            <div className="bg-black/30 px-3.5 py-2 rounded-xl border border-white/10 flex items-center justify-between">
              <span className="text-slate-400 text-[11px]">Protokol &amp; SSL:</span>
              <span className="font-mono text-sky-300 font-bold text-[11px]">TLS / SSL Encrypted</span>
            </div>
            <div className="bg-black/30 px-3.5 py-2 rounded-xl border border-white/10 flex items-center justify-between">
              <span className="text-slate-400 text-[11px]">Sinkronisasi Terakhir:</span>
              <span className="font-mono text-emerald-300 font-bold text-[11px]">
                {supabaseSyncState?.lastSyncedAt
                  ? `${new Date(supabaseSyncState.lastSyncedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} WIB`
                  : 'Real-Time Aktif'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Grid Tabel Relasional Aiven PostgreSQL */}
      <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-700 pb-3">
          <div>
            <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <i className="fa-solid fa-table-cells text-emerald-600"></i>
              Struktur Tabel Relasional Aiven PostgreSQL
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Tabel aktif yang tersimpan dan disinkronkan langsung pada basis data cloud Aiven.
            </p>
          </div>
          <span className="text-xs font-bold px-3 py-1 bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 rounded-full border border-emerald-200 dark:border-emerald-800 w-fit">
            {TABLE_MODULES.length} Tabel Aktif Terkelola
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {TABLE_MODULES.map((table) => {
            const isSel = selectedTable === table.id;
            return (
              <button
                key={table.id}
                type="button"
                onClick={() => setSelectedTable(table.id)}
                className={`p-3.5 rounded-xl border text-left transition cursor-pointer flex flex-col justify-between space-y-2 ${
                  isSel 
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 shadow-xs' 
                    : 'bg-slate-50 dark:bg-slate-700/40 border-slate-200 dark:border-slate-700 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs ${
                    isSel ? 'bg-emerald-600 text-white' : 'bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-300'
                  }`}>
                    <i className={`fa-solid ${table.icon}`}></i>
                  </div>
                  <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300">
                    {table.count} baris
                  </span>
                </div>
                <div>
                  <h4 className="font-bold text-xs text-slate-800 dark:text-slate-100">{table.label}</h4>
                  <p className="text-[10px] font-mono text-slate-400 mt-0.5">tabel: {table.name}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Panduan Konfigurasi Connection String Aiven */}
      <div className="bg-slate-900 text-slate-200 p-5 rounded-2xl shadow-sm border border-slate-800 space-y-3">
        <div className="flex items-center space-x-2 text-gold-400">
          <i className="fa-solid fa-key text-sm"></i>
          <h4 className="font-bold text-xs uppercase tracking-wider">Konfigurasi Koneksi Aiven (Environment)</h4>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          Koneksi Aiven PostgreSQL dikelola secara otomatis oleh server Express melalui environment variable <code className="text-emerald-400 font-mono">DATABASE_URL</code> dengan SSL mode <code className="text-emerald-400 font-mono">require</code>.
        </p>
        <div className="bg-black/50 p-3 rounded-xl border border-slate-800 text-[11px] font-mono text-emerald-400 overflow-x-auto">
          DATABASE_URL=postgres://avnadmin:[PASSWORD]@[HOST].aivencloud.com:[PORT]/defaultdb?sslmode=require
        </div>
      </div>
    </div>
  );
}
