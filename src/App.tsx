import React, { Component } from 'react';
import { AppProvider, useAppContext } from './store';
import { Login } from './components/Login';
import { Header } from './components/Header';
import { Dashboard } from './components/Dashboard';
import { RoomsView } from './components/RoomsView';
import { ReportsView, MaintenanceReportsView, AuditLogView, BreakfastOrdersView } from './components/OtherViews';
import { QualityControlView } from './components/QualityControlView';
import { BuildingStaffView } from './components/BuildingStaffView';
import { UserManagementView } from './components/UserManagementView';
import { SpreadsheetIntegrationView } from './components/SpreadsheetIntegrationView';
import { Modals } from './components/Modals';
import { FloatingChatPanel } from './components/FloatingChatPanel';

function ToastContainer() {
  const { toasts } = useAppContext();
  return (
    <div className="fixed bottom-5 left-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => {
        let bg = 'bg-slate-800 text-white';
        if (toast.type === 'success') bg = 'bg-emerald-700 text-white';
        if (toast.type === 'warning') bg = 'bg-amber-600 text-white';
        if (toast.type === 'error') bg = 'bg-red-700 text-white';
        
        return (
          <div key={toast.id} className={`${bg} px-4 py-3 rounded-xl shadow-xl text-xs font-bold flex items-center space-x-2 animate-bounce`}>
            <i className="fa-solid fa-circle-info"></i>
            <span>{toast.msg}</span>
          </div>
        );
      })}
    </div>
  );
}

function AccessDenied({ 
  tabTitle, 
  allowedRoles, 
  userRole, 
  onGoHome 
}: { 
  tabTitle: string; 
  allowedRoles: string[]; 
  userRole: string; 
  onGoHome: () => void;
}) {
  return (
    <div className="bg-white rounded-2xl p-8 border border-slate-200 shadow-sm text-center max-w-lg mx-auto my-12 space-y-4">
      <div className="w-16 h-16 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center text-2xl mx-auto shadow-inner border border-amber-200">
        <i className="fa-solid fa-lock"></i>
      </div>
      <div>
        <h3 className="text-lg font-bold text-slate-800">Akses Terbatas: {tabTitle}</h3>
        <p className="text-xs text-slate-500 mt-1">
          Peran akun Anda (<strong>{userRole}</strong>) tidak memiliki otorisasi untuk membuka halaman ini.
        </p>
      </div>
      <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-left text-xs space-y-1.5">
        <p className="font-bold text-slate-700 text-[11px] uppercase tracking-wider">Peran yang Memiliki Izin Akses:</p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {allowedRoles.map((r, i) => (
            <span key={i} className="px-2 py-0.5 bg-white border border-slate-300 rounded text-slate-700 font-medium text-[10px]">
              {r}
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={onGoHome}
        className="px-5 py-2.5 bg-hajj-700 hover:bg-hajj-800 text-white rounded-xl text-xs font-bold shadow transition flex items-center justify-center space-x-2 mx-auto"
      >
        <i className="fa-solid fa-arrow-left"></i>
        <span>Kembali ke Ruang Kerja Saya</span>
      </button>
    </div>
  );
}

const TAB_PERMISSIONS: Record<string, { title: string; roles: string[] }> = {
  dashboard: {
    title: 'Dashboard Operasional',
    roles: ['Super Admin', 'Admin', 'Manager Resepsionis', 'Resepsionis', 'Manager Keuangan', 'Bendahara', 'Keuangan', 'Bendahara / Keuangan', 'Staff Keuangan', 'Manager QC', 'Quality Control', 'Manager Teknisi', 'Teknisi', 'Manager Koperasi', 'Petugas Koperasi', 'Koperasi', 'Manager']
  },
  gedung: {
    title: 'Gedung & Kamar',
    roles: ['Super Admin', 'Admin', 'Manager Resepsionis', 'Resepsionis', 'Manager Keuangan', 'Bendahara', 'Keuangan', 'Bendahara / Keuangan', 'Staff Keuangan', 'Manager QC', 'Quality Control', 'Manager Teknisi', 'Teknisi', 'Manager Koperasi', 'Petugas Koperasi', 'Koperasi', 'Manager']
  },
  qualityControl: {
    title: 'Quality Control (QC)',
    roles: ['Super Admin', 'Admin', 'Manager QC', 'Quality Control', 'Manager Resepsionis', 'Manager']
  },
  buildingStaff: {
    title: 'Petugas Gedung & Housekeeping SOP',
    roles: ['Super Admin', 'Admin', 'Manager Petugas Gedung', 'Petugas Gedung', 'Manager QC', 'Quality Control', 'Manager']
  },
  laporanKamar: {
    title: 'Laporan Kamar, Pemesanan & Kwitansi',
    roles: ['Super Admin', 'Admin', 'Manager Resepsionis', 'Resepsionis', 'Manager Keuangan', 'Bendahara', 'Keuangan', 'Bendahara / Keuangan', 'Staff Keuangan', 'Manager']
  },
  laporanMaintenance: {
    title: 'Laporan Maintenance & Perbaikan',
    roles: ['Super Admin', 'Admin', 'Manager Teknisi', 'Teknisi', 'Manager QC', 'Quality Control', 'Manager Resepsionis', 'Manager']
  },
  pesananSarapan: {
    title: 'Pesanan Makan',
    roles: ['Super Admin', 'Admin', 'Manager Koperasi', 'Petugas Koperasi', 'Manager Resepsionis', 'Resepsionis', 'Manager', 'Koperasi']
  },
  auditLog: {
    title: 'Manajemen Sistem',
    roles: ['Super Admin', 'Admin', 'Manager Resepsionis', 'Resepsionis', 'Manager Keuangan', 'Bendahara', 'Keuangan', 'Bendahara / Keuangan', 'Staff Keuangan', 'Manager QC', 'Quality Control', 'Manager Teknisi', 'Teknisi', 'Manager Koperasi', 'Petugas Koperasi', 'Koperasi', 'Manager']
  },
  verifyPdf: {
    title: 'Manajemen Sistem (Log Unduh PDF)',
    roles: ['Super Admin', 'Admin', 'Manager Resepsionis', 'Resepsionis', 'Manager Keuangan', 'Bendahara', 'Keuangan', 'Bendahara / Keuangan', 'Staff Keuangan', 'Manager QC', 'Quality Control', 'Manager Teknisi', 'Teknisi', 'Manager Koperasi', 'Petugas Koperasi', 'Koperasi', 'Manager']
  },
  kelolaAnggota: {
    title: 'Kelola Petugas & Anggota',
    roles: ['Super Admin', 'Admin']
  },
  spreadsheetSync: {
    title: 'Google Spreadsheet',
    roles: ['Super Admin', 'Admin']
  }
};

function MainApp() {
  const { currentUser, activeTab, maintenances, setActiveTab } = useAppContext();
  
  if (!currentUser) {
    return (
      <>
        <Login />
        <ToastContainer />
      </>
    );
  }

  const urgentMaint = maintenances.filter(m => m.urgency === 'Urgent' && m.status === 'PROSES');

  const getDefaultTabForRole = (_role: string): string => {
    return 'dashboard';
  };

  const resolvedTab = 
    activeTab === 'rooms' ? 'gedung' :
    activeTab === 'qc' ? 'qualityControl' :
    activeTab === 'maintenance' ? 'laporanMaintenance' :
    activeTab === 'spreadsheetSync' ? 'auditLog' :
    activeTab;

  const currentTabConfig = TAB_PERMISSIONS[resolvedTab];
  const isTabAllowed = !currentTabConfig || currentTabConfig.roles.includes(currentUser.role);

  return (
    <div className="flex-grow flex flex-col w-full min-h-screen">
      <Header />
      <main className="flex-grow max-w-7xl w-full mx-auto px-2 sm:px-6 lg:px-8 py-3.5 sm:py-5 space-y-4">
        {urgentMaint.length > 0 && currentUser.role.includes('Teknisi') && (
          <div className="bg-red-600 text-white p-3.5 sm:p-4 rounded-xl shadow-md flex items-center justify-between animate-pulse">
            <div className="flex items-center space-x-2.5 sm:space-x-3">
              <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-white/20 flex items-center justify-center text-base sm:text-xl shrink-0">
                <i className="fa-solid fa-triangle-exclamation"></i>
              </div>
              <div>
                <h4 className="font-bold text-xs sm:text-sm">Peringatan Maintenance Urgent!</h4>
                <p className="text-[11px] sm:text-xs text-red-100">Terdapat {urgentMaint.length} fasilitas (seperti {urgentMaint[0].roomNumber}) membutuhkan perbaikan darurat segera!</p>
              </div>
            </div>
            <button onClick={() => setActiveTab('laporanMaintenance')} className="px-2.5 sm:px-3 py-1.5 bg-white text-red-700 text-xs font-bold rounded-lg shadow hover:bg-red-50 transition shrink-0">
              Lihat <span className="hidden sm:inline">Perawatan</span> <i className="fa-solid fa-arrow-right ml-1"></i>
            </button>
          </div>
        )}

        {!isTabAllowed ? (
          <div className="animate-in fade-in duration-200">
            <AccessDenied 
              tabTitle={currentTabConfig?.title || 'Halaman'}
              allowedRoles={currentTabConfig?.roles || []}
              userRole={currentUser.role}
              onGoHome={() => setActiveTab(getDefaultTabForRole(currentUser.role))}
            />
          </div>
        ) : (
          <div key={resolvedTab} className="animate-in fade-in duration-200">
            {resolvedTab === 'dashboard' && <Dashboard />}
            {resolvedTab === 'gedung' && <RoomsView />}
            {resolvedTab === 'qualityControl' && <QualityControlView />}
            {resolvedTab === 'buildingStaff' && <BuildingStaffView />}
            {resolvedTab === 'laporanKamar' && <ReportsView />}
            {resolvedTab === 'laporanMaintenance' && <MaintenanceReportsView />}
            {resolvedTab === 'pesananSarapan' && <BreakfastOrdersView />}
            {resolvedTab === 'auditLog' && <AuditLogView defaultSubView={activeTab === 'spreadsheetSync' ? 'SPREADSHEET_MGMT' : undefined} />}
            {resolvedTab === 'verifyPdf' && <AuditLogView defaultSubView="PDF_DOWNLOAD_LOGS" />}
            {resolvedTab === 'kelolaAnggota' && <UserManagementView />}
          </div>
        )}
      </main>
      
      <FloatingChatPanel />
      <Modals />
      <ToastContainer />
    </div>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  public state: { hasError: boolean; error: Error | null } = { hasError: false, error: null };
  public props!: { children: React.ReactNode };

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-xl max-w-md w-full text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-red-100 text-red-600 flex items-center justify-center text-2xl mx-auto shadow-inner">
              <i className="fa-solid fa-triangle-exclamation"></i>
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800">Terjadi Kendala Sistem</h3>
              <p className="text-xs text-slate-500 mt-1">
                Aplikasi mengalami galat saat merender komponen. Silakan muat ulang halaman atau reset cache jika masalah berlanjut.
              </p>
              {this.state.error && (
                <div className="mt-3 p-2 bg-slate-100 rounded text-[10px] text-red-600 font-mono text-left max-h-24 overflow-auto">
                  {this.state.error.toString()}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  window.location.reload();
                }}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow transition cursor-pointer"
              >
                <i className="fa-solid fa-rotate-right mr-1.5"></i>
                Muat Ulang Halaman
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.clear();
                  window.location.reload();
                }}
                className="py-2.5 px-4 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl text-xs font-bold transition cursor-pointer"
                title="Bersihkan cache lokal & reset data"
              >
                Reset Cache
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <MainApp />
      </AppProvider>
    </ErrorBoundary>
  );
}



