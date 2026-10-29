import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createHttpServer } from "http";

async function startServer() {
  const app = express();
  const httpServer = createHttpServer(app); // Menggunakan HTTP server terikat
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.text({ type: ["text/plain", "text/*"], limit: "10mb" }));

  // CORS & Multi-Host Header Support for multi-device cross-network connections
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Requested-With, Cache-Control, Pragma");
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  // Disable aggressive caching on Vercel and server proxies for all API endpoints
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
  });

  // =========================================================================
  // REAL-TIME MULTI-USER HUB (WORK SESSIONS, LIVE PRESENCE & 2-WAY CHAT)
  // =========================================================================
  interface RealtimePresence {
    clientId: string;
    userId: string;
    userName: string;
    userRole: string;
    department?: string;
    assignedBuilding?: string;
    sessionId?: string;
    loginTime?: string;
    activeTab?: string;
    lastSeenMs: number;
  }

  interface RealtimeState {
    presences: Record<string, RealtimePresence>;
    workSessions: any[];
    chatChannels: any[];
    chatMessages: any[];
  }

  const realtimeState: RealtimeState = {
    presences: {},
    workSessions: [],
    chatChannels: [],
    chatMessages: [],
  };

  const sseClients = new Set<express.Response>();

  function broadcastRealtimeEvent(type: string, payload: any, senderClientId?: string) {
    const message = JSON.stringify({
      type,
      payload,
      senderClientId: senderClientId || null,
      timestamp: Date.now(),
    });
    for (const client of sseClients) {
      try {
        client.write(`data: ${message}\n\n`);
      } catch (_) {
        sseClients.delete(client);
      }
    }
  }

  // Cleanup stale presences older than 120 seconds
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [key, p] of Object.entries(realtimeState.presences)) {
      if (now - p.lastSeenMs > 120000) {
        delete realtimeState.presences[key];
        changed = true;
      }
    }
    if (changed) {
      broadcastRealtimeEvent("presence:sync", Object.values(realtimeState.presences));
    }
  }, 15000);

  // =========================================================================
  // Google Spreadsheet Database Configuration & Real-Time Proxy
  // Menggunakan Google Spreadsheet sebagai basis data utama aplikasi
  // =========================================================================
  const sheetsConfigFilePath = path.join(process.cwd(), "google_sheets_config.json");
  const envFilePath = path.join(process.cwd(), ".env");

  function parseEnvForSheets(): { webAppUrl?: string; sheetId?: string; apiKey?: string } {
    try {
      if (fs.existsSync(envFilePath)) {
        const raw = fs.readFileSync(envFilePath, "utf-8");
        let webAppUrl: string | undefined;
        let sheetId: string | undefined;
        let apiKey: string | undefined;

        const urlMatch = raw.match(/(?:GOOGLE_SHEETS_WEBAPP_URL|VITE_SHEET_WEBAPP_URL)\s*=\s*["']?([^\r\n"']+)["']?/);
        if (urlMatch && urlMatch[1]) {
          webAppUrl = urlMatch[1].trim();
        }

        const idMatch = raw.match(/(?:GOOGLE_SHEETS_ID|VITE_GOOGLE_SHEETS_ID)\s*=\s*["']?([^\r\n"']+)["']?/);
        if (idMatch && idMatch[1]) {
          sheetId = idMatch[1].trim();
        }

        const keyMatch = raw.match(/GOOGLE_SHEETS_API_KEY\s*=\s*["']?([^\r\n"']+)["']?/);
        if (keyMatch && keyMatch[1]) {
          apiKey = keyMatch[1].trim();
        }

        return { webAppUrl, sheetId, apiKey };
      }
    } catch (_) {}
    return {};
  }

  const defaultWebAppUrl = "https://script.google.com/macros/s/AKfycby9Tok8-zgcVsTuXfQBDA0prmRSpUs9kxpeyczsw9SRVjwZBEk6Y8st3tBv7LK7j_X6/exec";
  const defaultSheetDocUrl = "https://docs.google.com/spreadsheets/d/15loY6F6CMmIJ5qZaafidY6AB0vvrEpsSsE_B0XXBqP4/edit?gid=0#gid=0";

  const envSheetsConfig = parseEnvForSheets();
  let activeSheetsConfig = {
    webAppUrl: envSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || process.env.VITE_SHEET_WEBAPP_URL || defaultWebAppUrl,
    sheetId: envSheetsConfig.sheetId || process.env.GOOGLE_SHEETS_ID || process.env.VITE_GOOGLE_SHEETS_ID || defaultSheetDocUrl,
    sheetDocUrl: defaultSheetDocUrl,
    apiKey: envSheetsConfig.apiKey || process.env.GOOGLE_SHEETS_API_KEY || "",
    isConfigured: true,
    updatedAt: new Date().toISOString(),
  };

  try {
    if (fs.existsSync(sheetsConfigFilePath)) {
      const rawCfg = fs.readFileSync(sheetsConfigFilePath, "utf-8");
      const parsed = JSON.parse(rawCfg);
      if (parsed) {
        const rawSheetId = parsed.sheetId || activeSheetsConfig.sheetId;
        const finalDocUrl = parsed.sheetDocUrl || rawSheetId || defaultSheetDocUrl;
        const safeDocUrl = (finalDocUrl && !finalDocUrl.includes("1AsramaHajiEmbarkasiJakartaSIM")) ? finalDocUrl : defaultSheetDocUrl;
        activeSheetsConfig = {
          webAppUrl: parsed.webAppUrl || activeSheetsConfig.webAppUrl,
          sheetId: safeDocUrl,
          sheetDocUrl: safeDocUrl,
          apiKey: parsed.apiKey || activeSheetsConfig.apiKey,
          isConfigured: Boolean(parsed.webAppUrl || activeSheetsConfig.webAppUrl),
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    } else if (activeSheetsConfig.webAppUrl) {
      activeSheetsConfig.isConfigured = true;
      fs.writeFileSync(sheetsConfigFilePath, JSON.stringify(activeSheetsConfig, null, 2), "utf-8");
    }
  } catch (err) {
    console.warn("Failed to load google_sheets_config.json:", err);
  }

  // File cache lokal di server untuk database authoritatif saat offline / backup
  const serverDbCachePath = path.join(process.cwd(), "server_database_cache.json");
  let serverDatabaseCache: any = null;
  try {
    if (fs.existsSync(serverDbCachePath)) {
      serverDatabaseCache = JSON.parse(fs.readFileSync(serverDbCachePath, "utf-8"));
    }
  } catch (_) {}

  // Inisialisasi realtimeState secara authoritatif dari serverDatabaseCache agar tidak kosong saat baru start
  if (serverDatabaseCache) {
    if (Array.isArray(serverDatabaseCache.chatChannels) && serverDatabaseCache.chatChannels.length > 0 && realtimeState.chatChannels.length === 0) {
      realtimeState.chatChannels = serverDatabaseCache.chatChannels;
    }
    if (Array.isArray(serverDatabaseCache.chatMessages) && serverDatabaseCache.chatMessages.length > 0 && realtimeState.chatMessages.length === 0) {
      realtimeState.chatMessages = serverDatabaseCache.chatMessages;
    }
    if (Array.isArray(serverDatabaseCache.workSessions) && serverDatabaseCache.workSessions.length > 0 && realtimeState.workSessions.length === 0) {
      realtimeState.workSessions = serverDatabaseCache.workSessions;
    }
  }

  // File penyimpanan permanen database chat mengambang (Grup & 1-on-1 Direct Chat)
  const chatStoragePath = path.join(process.cwd(), "chat_storage_database.json");
  try {
    if (fs.existsSync(chatStoragePath)) {
      const savedChat = JSON.parse(fs.readFileSync(chatStoragePath, "utf-8"));
      if (savedChat && Array.isArray(savedChat.channels) && savedChat.channels.length > 0) {
        realtimeState.chatChannels = savedChat.channels;
      }
      if (savedChat && Array.isArray(savedChat.messages) && savedChat.messages.length > 0) {
        realtimeState.chatMessages = savedChat.messages;
      }
    } else if (realtimeState.chatChannels.length > 0 || realtimeState.chatMessages.length > 0) {
      // Buat file chat_storage_database.json pertama kali dari template
      fs.writeFileSync(
        chatStoragePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date().toISOString(),
            channels: realtimeState.chatChannels,
            messages: realtimeState.chatMessages,
          },
          null,
          2
        ),
        "utf-8"
      );
    }
  } catch (err) {
    console.warn("Gagal memuat chat_storage_database.json:", err);
  }

  function saveChatStorageToDisk() {
    try {
      fs.writeFileSync(
        chatStoragePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date().toISOString(),
            channels: realtimeState.chatChannels,
            messages: realtimeState.chatMessages,
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch (err) {
      console.warn("Gagal menyimpan chat_storage_database.json:", err);
    }
    triggerAsyncChatSpreadsheetSync();
  }

  // 1. Endpoint status konfigurasi Google Spreadsheet
  app.get("/api/sheets-config", (_req, res) => {
    res.json(activeSheetsConfig);
  });

  // 2. Endpoint simpan konfigurasi Google Spreadsheet
  app.post("/api/sheets-config", (req, res) => {
    const { webAppUrl, sheetId, apiKey } = req.body || {};
    const cleanUrl = String(webAppUrl || "").trim();
    const cleanSheetId = String(sheetId || "").trim();
    const cleanApiKey = String(apiKey || "").trim();

    const cleanDocUrl = cleanSheetId || defaultSheetDocUrl;
    activeSheetsConfig = {
      webAppUrl: cleanUrl,
      sheetId: cleanDocUrl,
      sheetDocUrl: cleanDocUrl,
      apiKey: cleanApiKey,
      isConfigured: Boolean(cleanUrl),
      updatedAt: new Date().toISOString(),
    };

    process.env.GOOGLE_SHEETS_WEBAPP_URL = cleanUrl;
    process.env.VITE_SHEET_WEBAPP_URL = cleanUrl;
    if (cleanSheetId) process.env.GOOGLE_SHEETS_ID = cleanSheetId;

    try {
      fs.writeFileSync(sheetsConfigFilePath, JSON.stringify(activeSheetsConfig, null, 2), "utf-8");
      
      // Update .env file agar dev server & command line tools membaca konfigurasi ini
      let envContent = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, "utf-8") : "";
      if (cleanUrl) {
        if (envContent.includes("GOOGLE_SHEETS_WEBAPP_URL=")) {
          envContent = envContent.replace(/GOOGLE_SHEETS_WEBAPP_URL=.*/, `GOOGLE_SHEETS_WEBAPP_URL=${cleanUrl}`);
        } else {
          envContent += `\nGOOGLE_SHEETS_WEBAPP_URL=${cleanUrl}`;
        }
      }
      fs.writeFileSync(envFilePath, envContent, "utf-8");
    } catch (err) {
      console.warn("Gagal menyimpan google_sheets_config.json:", err);
    }

    broadcastRealtimeEvent("config:sheets", activeSheetsConfig);
    res.json({ ok: true, config: activeSheetsConfig });
  });

  // Skema Baku Database SIM Asrama Haji untuk Google Spreadsheet (Lengkap & Terstandarisasi)
  const APP_DATABASE_SCHEMA: Record<string, {
    sheetName: string;
    label: string;
    category: "Katalog & Master" | "Operasional & Transaksi" | "Sistem & Pengguna";
    headers: string[];
    description: string;
  }> = {
    buildings: {
      sheetName: "buildings",
      label: "Gedung & Properti",
      category: "Katalog & Master",
      headers: [
        "id",
        "name",
        "code",
        "floors",
        "total_rooms",
        "capacity_desc",
        "category",
        "status",
        "description",
        "created_at",
        "updated_at",
      ],
      description: "Data master gedung penginapan, asrama, kantor, dan aula serbaguna",
    },
    rooms: {
      sheetName: "rooms",
      label: "Kamar & Unit Hunian",
      category: "Katalog & Master",
      headers: [
        "id",
        "room_number",
        "building",
        "building_id",
        "floor",
        "type",
        "bed_type",
        "capacity",
        "capacity_number",
        "status",
        "price_per_night",
        "facilities",
        "qc_status",
        "last_qc_date",
        "last_qc_by",
        "last_qc_notes",
        "active_tx_id",
        "active_maint_id",
        "notes",
        "created_at",
        "updated_at",
      ],
      description: "Master unit kamar hunian, nomor kamar, gedung, kapasitas, dan tarif",
    },
    meeting_rooms: {
      sheetName: "meeting_rooms",
      label: "Ruang Pertemuan / Aula",
      category: "Katalog & Master",
      headers: [
        "id",
        "name",
        "code",
        "category",
        "building",
        "floor",
        "capacity",
        "capacity_number",
        "daily_rate",
        "session_rate",
        "rate_half_day",
        "rate_full_day",
        "status",
        "qc_status",
        "facilities",
        "amenities",
        "description",
        "active_tx_id",
        "active_maint_id",
        "notes",
        "created_at",
        "updated_at",
      ],
      description: "Ruang serbaguna (SG), ballroom rapat, dan fasilitas aula",
    },
    room_capacity_rates: {
      sheetName: "room_capacity_rates",
      label: "Katalog Tipe Kamar & Tarif Kapasitas",
      category: "Katalog & Master",
      headers: [
        "id",
        "room_type",
        "bed_type",
        "capacity_pax",
        "price_per_night",
        "description",
        "facilities",
        "is_active",
        "updated_at",
      ],
      description: "Master tipe kamar (Ekonomi, Standar, Superior), varian bed (Double s/d 8 Single Bed), kapasitas pax, dan tarif per malam",
    },
    breakfast_menu_items: {
      sheetName: "breakfast_menu_items",
      label: "Katalog Menu Katering & Sarapan",
      category: "Katalog & Master",
      headers: [
        "id",
        "name",
        "category",
        "price",
        "description",
        "is_available",
        "allergens",
        "updated_at",
      ],
      description: "Katalog menu makanan berat, bubur/sayur, snack/kudapan, minuman, dan sehat lansia",
    },
    transactions: {
      sheetName: "transactions",
      label: "Reservasi & Tamu",
      category: "Operasional & Transaksi",
      headers: [
        "id",
        "room_id",
        "room_number",
        "building",
        "guest_name",
        "guest_type",
        "nik_ktp",
        "kloter",
        "phone",
        "email",
        "category",
        "status",
        "start_date",
        "duration",
        "duration_unit",
        "price_per_night",
        "total_amount",
        "payment_status",
        "payment_method",
        "payment_date",
        "payment_note",
        "kwitansi_no",
        "is_paid",
        "paid_amount",
        "dp_amount",
        "dp_date",
        "dp_method",
        "dp_note",
        "remaining_amount",
        "already_paid",
        "va_number",
        "va_account_name",
        "bank_name",
        "bank_account_number",
        "is_group",
        "group_id",
        "group_type",
        "group_name",
        "group_pic",
        "group_pic_phone",
        "total_pax",
        "agency_or_document",
        "spk_number",
        "allocated_room_numbers",
        "allocated_rooms_count",
        "include_aula",
        "rent_aula_id",
        "rent_aula_name",
        "rent_aula_duration",
        "rent_aula_duration_days",
        "rent_aula_session",
        "catering_package",
        "catering_pax_count",
        "breakfast",
        "breakfast_menu",
        "breakfast_portions",
        "breakfast_days",
        "breakfast_status",
        "rent_type",
        "extra_bed",
        "extra_bed_count",
        "extra_bed_price",
        "extra_bed_notes",
        "check_in_time",
        "check_out_time",
        "notes",
        "created_user",
        "created_at",
        "updated_at",
        "cancelled_at",
        "cancel_reason",
        "cancelled_user",
        "extended_count",
        "extend_history",
      ],
      description: "Buku tamu lengkap, registrasi individu/rombongan, check-in, check-out, rincian pembayaran DP/Lunas, dan histori perpanjangan",
    },
    users: {
      sheetName: "users",
      label: "Pengguna & Petugas",
      category: "Sistem & Pengguna",
      headers: [
        "id",
        "username",
        "full_name",
        "role",
        "department",
        "assigned_building",
        "supervisor_id",
        "phone",
        "email",
        "nip",
        "status",
        "is_owner",
        "password",
        "signature_url",
        "qr_code_url",
        "permissions",
        "updated_at",
      ],
      description: "Daftar akun staf resepsionis, keuangan/bendahara, QC, teknisi, tanda tangan digital, dan otorisasi sistem",
    },
    maintenances: {
      sheetName: "maintenances",
      label: "Perawatan Fasilitas",
      category: "Operasional & Transaksi",
      headers: [
        "id",
        "room_id",
        "room_number",
        "building",
        "category",
        "issue",
        "description",
        "urgency",
        "status",
        "technician",
        "assigned_technician_id",
        "assigned_technician_name",
        "assigned_by_manager",
        "assigned_time",
        "manager_notes",
        "technician_notes",
        "work_completed_time",
        "reporter",
        "reported_user",
        "report_time",
        "created_at",
        "resolved_time",
        "resolved_at",
        "qc_inspection_id",
        "qc_verdict",
        "facility_type",
        "notes",
        "updated_at",
      ],
      description: "Tiket kerusakan, disposisi teknisi, pelaporan, dan verifikasi perbaikan fasilitas asrama",
    },
    qc_inspections: {
      sheetName: "qc_inspections",
      label: "Inspeksi Mutu QC",
      category: "Operasional & Transaksi",
      headers: [
        "id",
        "room_id",
        "building",
        "room_number",
        "inspector_id",
        "inspector_name",
        "inspection_date",
        "cleanliness",
        "linen_bed",
        "ac_electricity",
        "plumbing_water",
        "amenities",
        "result",
        "decision_type",
        "notes",
        "maintenance_id_created",
        "facility_type",
        "updated_at",
      ],
      description: "Checklist audit mutu 5 aspek, verifikasi kelaikan kamar/aula, dan tindak lanjut perawatan",
    },
    breakfast_orders: {
      sheetName: "breakfast_orders",
      label: "Pesanan Konsumsi & Sarapan",
      category: "Operasional & Transaksi",
      headers: [
        "id",
        "room_number",
        "building",
        "guest_name",
        "phone",
        "kloter",
        "transaction_id",
        "menu_id",
        "menu_name",
        "portions",
        "days",
        "start_date",
        "order_date",
        "delivery_time",
        "status",
        "price_per_portion",
        "total_price",
        "dietary_restriction",
        "notes",
        "cancel_reason",
        "cancelled_at",
        "created_at",
        "updated_at",
      ],
      description: "Pesanan sarapan kamar, catering prasmanan aula, porsi harian, dan status pengantaran dapur",
    },
    cleaning_logs: {
      sheetName: "cleaning_logs",
      label: "Laporan Pembersihan & Foto Bukti Petugas Gedung",
      category: "Operasional & Transaksi",
      headers: [
        "id",
        "room_id",
        "meeting_room_id",
        "building",
        "room_number",
        "petugas_id",
        "petugas_name",
        "timestamp",
        "photo_url",
        "notes",
        "status",
        "created_at",
        "updated_at",
      ],
      description: "Arsip pembersihan sterilisasi ruangan/aula, bukti foto real kamera/folder ber-watermark waktu, nama petugas, dan status QC",
    },
    work_sessions: {
      sheetName: "work_sessions",
      label: "Sesi Jam Kerja Petugas",
      category: "Sistem & Pengguna",
      headers: [
        "id",
        "user_id",
        "user_name",
        "user_role",
        "department",
        "assigned_building",
        "login_time",
        "logout_time",
        "duration_seconds",
        "duration_formatted",
        "status",
        "last_heartbeat",
        "device_info",
        "notes",
      ],
      description: "Presensi digital, detak aktif (heartbeat), riwayat durasi jam kerja staf, dan perangkat login",
    },
    app_settings: {
      sheetName: "app_settings",
      label: "Pengaturan Profil Instansi",
      category: "Sistem & Pengguna",
      headers: [
        "organization_name",
        "sub_title",
        "ministry_name",
        "address",
        "phone",
        "email",
        "portal_url",
        "tag_title",
        "app_logo",
        "app_favicon",
        "updated_at",
      ],
      description: "Identitas resmi instansi UPT Asrama Haji Jakarta, logo instansi, kontak resmi, dan portal",
    },
    system_logs: {
      sheetName: "system_logs",
      label: "Audit Log Sistem",
      category: "Sistem & Pengguna",
      headers: [
        "id",
        "timestamp",
        "user",
        "role",
        "action",
        "details",
        "duration_minutes",
        "verification_code",
        "document_title",
        "target_id",
        "signatory_name",
        "signatory_role",
        "signatory_nip",
        "qr_code_hash",
        "has_qr_and_signature",
      ],
      description: "Audit trail aktivitas sistem, verifikasi tanda tangan sah ber-QR, dan riwayat operasional",
    },
    chat_channels: {
      sheetName: "chat_channels",
      label: "Saluran & Grup Chat",
      category: "Sistem & Pengguna",
      headers: [
        "id",
        "name",
        "scope",
        "type",
        "department",
        "participant_ids",
        "description",
        "icon",
        "last_message",
        "last_message_time",
        "last_sender_name",
        "created_at",
        "updated_at",
      ],
      description: "Daftar saluran chat grup divisi, forum koordinasi terpadu, dan ruang chat personal 1-on-1",
    },
    chat_messages: {
      sheetName: "chat_messages",
      label: "Riwayat Pesan Chat",
      category: "Sistem & Pengguna",
      headers: [
        "id",
        "channel_id",
        "channel_type",
        "sender_id",
        "sender_name",
        "sender_role",
        "sender_department",
        "message",
        "timestamp",
        "time_formatted",
        "priority",
        "is_instruction",
        "read_by",
        "reply_to_id",
        "reply_to_sender",
        "reply_to_text",
        "created_at",
      ],
      description: "Penyimpanan permanen riwayat pesan obrolan grup dan chat pribadi dengan timestamp ISO, status prioritas, dan tanda baca",
    },
  };

  /**
   * Helper fetch khusus untuk Google Apps Script Web App
   * Mengatasi redirect 302/307, menyertakan User-Agent agar tidak diblokir firewall Google (HTTP 403),
   * dan mendukung batas waktu (timeout).
   */
  async function fetchGoogleAppsScript(url: string, options: RequestInit = {}): Promise<Response> {
    const defaultHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SIM-Asrama-Haji-Client/2.0",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    };

    const mergedHeaders = {
      ...defaultHeaders,
      ...(options.headers as Record<string, string> || {}),
    };

    return fetch(url, {
      ...options,
      headers: mergedHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  }

  let chatSyncTimeout: NodeJS.Timeout | null = null;
  function triggerAsyncChatSpreadsheetSync() {
    const targetUrl = (activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "").trim();
    if (!targetUrl) return;
    if (chatSyncTimeout) clearTimeout(chatSyncTimeout);
    chatSyncTimeout = setTimeout(async () => {
      try {
        const payload = {
          action: "BATCH_OPERATIONS",
          timestamp: new Date().toISOString(),
          operations: [
            { action: "WRITE", sheet: "chat_channels", data: realtimeState.chatChannels },
            { action: "WRITE", sheet: "chat_messages", data: realtimeState.chatMessages },
          ],
          spreadsheetId: activeSheetsConfig.sheetId || undefined,
        };
        fetchGoogleAppsScript(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } catch (_) {}
    }, 1500);
  }

  let sessionSyncTimeout: NodeJS.Timeout | null = null;
  function triggerAsyncWorkSessionSpreadsheetSync() {
    const targetUrl = (activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "").trim();
    if (!targetUrl) return;
    if (sessionSyncTimeout) clearTimeout(sessionSyncTimeout);
    sessionSyncTimeout = setTimeout(async () => {
      try {
        const payload = {
          action: "BATCH_OPERATIONS",
          timestamp: new Date().toISOString(),
          operations: [
            { action: "WRITE", sheet: "work_sessions", data: realtimeState.workSessions },
          ],
          spreadsheetId: activeSheetsConfig.sheetId || undefined,
        };
        fetchGoogleAppsScript(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } catch (_) {}
    }, 1500);
  }

  // Endpoint Mendapatkan Definisi Skema Tabel & Header
  app.get("/api/sheets/schema-definition", (_req, res) => {
    res.json({
      status: "success",
      schema: APP_DATABASE_SCHEMA,
      tableCount: Object.keys(APP_DATABASE_SCHEMA).length,
    });
  });

  function matchHeader(expected: string, foundHeaders: string[]): boolean {
    const normExpected = expected.toLowerCase().replace(/[^a-z0-9]/g, "");
    return foundHeaders.some((fh) => {
      const normFound = fh.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normFound === normExpected) return true;
      // Alias mappings (CamelCase vs snake_case & sinonim)
      if (normExpected === "fullname" && (normFound === "name" || normFound === "nama")) return true;
      if (normExpected === "name" && (normFound === "fullname" || normFound === "nama")) return true;
      if (normExpected === "roomnumber" && (normFound === "nokamar" || normFound === "nomorkamar")) return true;
      if (normExpected === "bedtype" && (normFound === "bed" || normFound === "tipebed")) return true;
      if (normExpected === "pricepernight" && (normFound === "tarif" || normFound === "harga" || normFound === "price")) return true;
      if (normExpected === "assignedbuilding" && (normFound === "building" || normFound === "gedung")) return true;
      if (normExpected === "building" && (normFound === "assignedbuilding" || normFound === "gedung")) return true;
      if (normExpected === "capacitypax" && (normFound === "capacity" || normFound === "capacitynumber" || normFound === "kapasitas")) return true;
      if (normExpected === "capacity" && (normFound === "capacitynumber" || normFound === "capacitypax" || normFound === "kapasitas")) return true;
      if (normExpected === "capacitynumber" && (normFound === "capacity" || normFound === "capacitypax" || normFound === "kapasitas")) return true;
      if (normExpected === "ratehalfday" && (normFound === "sessionrate" || normFound === "ratesession" || normFound === "halfday")) return true;
      if (normExpected === "ratefullday" && (normFound === "dailyrate" || normFound === "ratedaily" || normFound === "fullday")) return true;
      if (normExpected === "qcstatus" && (normFound === "statusqc" || normFound === "mutu")) return true;
      if (normExpected === "activetxid" && (normFound === "txid" || normFound === "transactionid")) return true;
      if (normExpected === "activemaintid" && (normFound === "maintid" || normFound === "maintenanceid")) return true;
      if (normExpected === "nikktp" && (normFound === "nik" || normFound === "ktp" || normFound === "noktp")) return true;
      if (normExpected === "totalamount" && (normFound === "totalbiaya" || normFound === "total" || normFound === "biaya")) return true;
      if (normExpected === "createdat" && (normFound === "createdtime" || normFound === "tanggalbuat")) return true;
      if (normExpected === "updatedat" && (normFound === "updatedtime" || normFound === "tanggalubah")) return true;
      if (normExpected === "startdate" && (normFound === "orderdate" || normFound === "tanggal")) return true;
      if (normExpected === "petugasname" && (normFound === "petugas" || normFound === "namapetugas")) return true;
      if (normExpected === "photourl" && (normFound === "foto" || normFound === "buktifoto" || normFound === "gambar" || normFound === "fotourl")) return true;
      return false;
    });
  }

  // Endpoint Deteksi & Inspeksi Struktur Sheet & Header di Spreadsheet
  app.post("/api/sheets/inspect", async (req, res) => {
    const targetUrl = (req.body?.webAppUrl || activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "").trim();

    if (!targetUrl) {
      return res.status(400).json({
        ok: false,
        error: "URL Web App Google Apps Script belum dikonfigurasi.",
      });
    }

    try {
      // Coba kirim inspect request ke Web App
      let inspectResult: any = null;
      let rawData: any = null;
      let isForbidden = false;

      try {
        const inspectRes = await fetchGoogleAppsScript(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "INSPECT_SCHEMA" }),
        });
        if (inspectRes.status === 403) {
          isForbidden = true;
        } else if (inspectRes.ok) {
          const text = await inspectRes.text();
          try {
            inspectResult = JSON.parse(text);
          } catch (_) {}
        }
      } catch (err: any) {
        if (String(err?.message || "").includes("403")) {
          isForbidden = true;
        }
      }

      // Jika POST inspect belum didukung skrip lama, fallback ke GET untuk melihat data yang ada
      if (!isForbidden && (!inspectResult || inspectResult.status !== "success" || !Array.isArray(inspectResult.sheets))) {
        try {
          const getRes = await fetchGoogleAppsScript(targetUrl, {
            method: "GET",
          });
          if (getRes.status === 403) {
            isForbidden = true;
          } else if (getRes.ok) {
            const text = await getRes.text();
            try {
              rawData = JSON.parse(text);
            } catch (_) {}
          }
        } catch (err: any) {
          if (String(err?.message || "").includes("403")) {
            isForbidden = true;
          }
        }
      }

      if (isForbidden) {
        return res.json({
          ok: false,
          isForbidden: true,
          error: "Akses Web App ditolak oleh Google (HTTP 403 Forbidden).",
          hint: "Buka Google Apps Script > Deploy > Manage deployments > Edit > Ubah 'Who has access' (Siapa yang memiliki akses) ke 'Anyone' (Siapa Saja) > Deploy.",
          schema: APP_DATABASE_SCHEMA,
          sheetReports: Object.entries(APP_DATABASE_SCHEMA).map(([key, def]) => ({
            key,
            sheetName: def.sheetName,
            label: def.label,
            description: def.description,
            exists: false,
            expectedHeaders: def.headers,
            foundHeaders: [],
            missingHeaders: def.headers,
            status: "MISSING_SHEET" as const,
          })),
          overallStatus: "FORBIDDEN",
          totalExpected: Object.keys(APP_DATABASE_SCHEMA).length,
          totalReady: 0,
          totalMissingSheets: Object.keys(APP_DATABASE_SCHEMA).length,
        });
      }

      // Bangun laporan status per lembar kerja & kumpulkan sheet konflik jika ada
      const existingSheetsMap = new Map<string, string[]>();
      const conflictSheetsFound: string[] = [];

      if (inspectResult?.sheets && Array.isArray(inspectResult.sheets)) {
        for (const s of inspectResult.sheets) {
          if (s && s.name) {
            const sheetNameStr = String(s.name);
            if (sheetNameStr.toLowerCase().includes("conflict")) {
              conflictSheetsFound.push(sheetNameStr);
              continue; // Abaikan sheet konflik dari skema utama
            }
            existingSheetsMap.set(sheetNameStr.toLowerCase(), Array.isArray(s.headers) ? s.headers.map(String) : []);
          }
        }
      } else if (rawData?.sheets && Array.isArray(rawData.sheets)) {
        for (const s of rawData.sheets) {
          if (s && s.name) {
            const sheetNameStr = String(s.name);
            if (sheetNameStr.toLowerCase().includes("conflict")) {
              conflictSheetsFound.push(sheetNameStr);
              continue;
            }
            existingSheetsMap.set(sheetNameStr.toLowerCase(), Array.isArray(s.headers) ? s.headers.map(String) : []);
          }
        }
      } else if (rawData) {
        const d = rawData.data || rawData;
        if (d && typeof d === "object") {
          for (const key of Object.keys(d)) {
            if (key.toLowerCase().includes("conflict")) {
              conflictSheetsFound.push(key);
              continue;
            }
            const arr = d[key];
            const headers = (Array.isArray(arr) && arr[0] && typeof arr[0] === "object") ? Object.keys(arr[0]) : [];
            existingSheetsMap.set(key.toLowerCase(), headers);
          }
        }
      }

      // Pencari sheet dengan pencocokan nama fleksibel (case-insensitive & underscore-insensitive)
      const findExistingHeaders = (targetName: string): { exists: boolean; headers: string[] } => {
        const normTarget = targetName.toLowerCase().replace(/[^a-z0-9]/g, "");
        for (const [sKey, headers] of existingSheetsMap.entries()) {
          const normKey = sKey.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (normKey === normTarget) {
            return { exists: true, headers };
          }
        }
        return { exists: false, headers: [] };
      };

      const sheetReports = Object.entries(APP_DATABASE_SCHEMA).map(([key, def]) => {
        const { exists, headers: foundHeaders } = findExistingHeaders(def.sheetName);
        const missingHeaders = def.headers.filter((h) => !matchHeader(h, foundHeaders));

        let status: "READY" | "MISSING_HEADERS" | "MISSING_SHEET" = "READY";
        if (!exists) {
          status = "MISSING_SHEET";
        } else if (missingHeaders.length > 0 && foundHeaders.length > 0) {
          status = "MISSING_HEADERS";
        } else if (foundHeaders.length === 0) {
          // Sheet ada namun belum memiliki header baris 1
          status = "MISSING_HEADERS";
        }

        return {
          key,
          sheetName: def.sheetName,
          label: def.label,
          description: def.description,
          exists,
          expectedHeaders: def.headers,
          foundHeaders,
          missingHeaders,
          status,
        };
      });

      const totalExpected = sheetReports.length;
      const totalReady = sheetReports.filter((r) => r.status === "READY").length;
      const totalMissingSheets = sheetReports.filter((r) => r.status === "MISSING_SHEET").length;

      // Deteksi apakah skrip Google Apps Script masih versi lama (hanya mengekspos 4 tabel master awal)
      const isLegacyAppsScript = !inspectResult?.sheets && !rawData?.sheets && existingSheetsMap.size > 0 && existingSheetsMap.size <= 4 && totalMissingSheets >= 8;

      const overallStatus = isLegacyAppsScript ? "LEGACY_SCRIPT" : totalReady === totalExpected ? "READY" : "NEEDS_PROVISIONING";

      res.json({
        ok: true,
        overallStatus,
        isLegacyAppsScript,
        legacyNotice: isLegacyAppsScript ? "Skrip Google Apps Script di Spreadsheet Anda masih versi lama (hanya mengekspos 4 dari 13 tabel). Lembar kerja di Google Spreadsheet Anda sebenarnya sudah ada, namun perlu menyalin skrip Code.gs terbaru dan melakukan Deploy Versi Baru (New deployment)." : null,
        totalExpected,
        totalReady,
        totalMissingSheets,
        sheetReports,
        conflictSheetsFound,
        inspectedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn("Gagal melakukan inspeksi skema spreadsheet:", err?.message || err);
      res.json({
        ok: false,
        error: `Gagal menginspeksi Spreadsheet: ${err?.message || "Kesalahan jaringan"}`,
      });
    }
  });

  // Endpoint Pembersihan Sheet Konflik Otomatis (seperti users_conflict...)
  app.post("/api/sheets/clean-conflicts", async (req, res) => {
    const targetUrl = (req.body?.webAppUrl || activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "").trim();

    if (!targetUrl) {
      return res.status(400).json({
        ok: false,
        error: "URL Web App Google Apps Script belum dikonfigurasi.",
      });
    }

    try {
      const resp = await fetchGoogleAppsScript(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "CLEAN_CONFLICT_SHEETS" }),
      });

      const text = await resp.text().catch(() => "");
      let j: any = {};
      try {
        j = JSON.parse(text);
      } catch (_) {
        j = { raw: text };
      }

      res.json({
        ok: true,
        message: "Perintah pembersihan sheet konflik berhasil dikirim ke Google Spreadsheet.",
        details: j,
      });
    } catch (err: any) {
      console.warn("Gagal membersihkan sheet konflik:", err?.message || err);
      res.status(500).json({
        ok: false,
        error: err?.message || "Gagal menghubungi Apps Script",
      });
    }
  });

  // Helper normalisasi item data agar memiliki representasi snake_case DAN camelCase secara lengkap
  function normalizeItemsList(items: any[]): any[] {
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
      if (!item || typeof item !== "object") return item;
      const norm: Record<string, any> = { ...item };
      for (const [k, v] of Object.entries(item)) {
        let formattedVal = v;
        if (v !== null && typeof v === "object") {
          if (Array.isArray(v)) {
            if (v.length > 0 && typeof v[0] === "object") {
              formattedVal = JSON.stringify(v);
            } else {
              formattedVal = v.join(", ");
            }
          } else {
            formattedVal = JSON.stringify(v);
          }
        }

        // Sanitasi ukuran sel Google Spreadsheet (Batas maksimum sel Google Sheets adalah 50.000 karakter)
        if (typeof formattedVal === "string") {
          if ((k === "appLogo" || k === "app_logo") && (formattedVal.length > 20000 || formattedVal.startsWith("data:image/"))) {
            formattedVal = "OFFICIAL_LOGO";
          } else if (formattedVal.length > 45000) {
            formattedVal = formattedVal.slice(0, 45000);
          }
        }

        const snake = k.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        const camel = k.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (norm[snake] === undefined) norm[snake] = formattedVal;
        if (norm[camel] === undefined) norm[camel] = formattedVal;
      }
      return norm;
    });
  }

  function formatDatabaseForSpreadsheet(data: any): Record<string, any> {
    const rawSettings = data?.appSettings || data?.app_settings || null;
    const appSettingsList = rawSettings ? normalizeItemsList(Array.isArray(rawSettings) ? rawSettings : [rawSettings]) : [];
    const rawRooms = Array.isArray(data?.rooms) ? data.rooms : [];
    // Filter kamar hunian murni (menghindari duplikasi fasilitas Ruang Pertemuan / Aula yang memiliki sheet tersendiri)
    const pureLodgingRooms = rawRooms.filter((r: any) => {
      if (!r) return false;
      const b = (r.building || "").toLowerCase();
      const t = (r.type || "").toLowerCase();
      const id = (r.id || "").toLowerCase();
      if (id.startsWith("mr-")) return false;
      if (b.includes("pertemuan") || b.includes("aula") || b.includes("serbaguna")) return false;
      if (t.includes("pertemuan") || t.includes("aula") || t.includes("serbaguna")) return false;
      return true;
    });
    const buildingsList = normalizeItemsList(Array.isArray(data?.buildings) ? data.buildings : []);
    const roomsList = normalizeItemsList(pureLodgingRooms);
    const meetingRoomsList = normalizeItemsList(Array.isArray(data?.meetingRooms) ? data.meetingRooms : (Array.isArray(data?.meeting_rooms) ? data.meeting_rooms : []));
    const roomCapacityRatesList = normalizeItemsList(Array.isArray(data?.roomCapacityRates) ? data.roomCapacityRates : (Array.isArray(data?.room_capacity_rates) ? data.room_capacity_rates : []));
    const breakfastMenuItemsList = normalizeItemsList(Array.isArray(data?.breakfastMenuItems) ? data.breakfastMenuItems : (Array.isArray(data?.breakfast_menu_items) ? data.breakfast_menu_items : []));
    const breakfastOrdersList = normalizeItemsList(Array.isArray(data?.breakfastOrders) ? data.breakfastOrders : (Array.isArray(data?.breakfast_orders) ? data.breakfast_orders : []));
    const transactionsList = normalizeItemsList(Array.isArray(data?.transactions) ? data.transactions : []);
    const usersList = normalizeItemsList(Array.isArray(data?.users) ? data.users : []);
    const maintenancesList = normalizeItemsList(Array.isArray(data?.maintenances) ? data.maintenances : []);
    const qcInspectionsList = normalizeItemsList(Array.isArray(data?.qcInspections) ? data.qcInspections : (Array.isArray(data?.qc_inspections) ? data.qc_inspections : []));
    const workSessionsList = normalizeItemsList(Array.isArray(data?.workSessions) ? data.workSessions : (Array.isArray(data?.work_sessions) ? data.work_sessions : []));
    const cleaningLogsList = normalizeItemsList(Array.isArray(data?.cleaningLogs) ? data.cleaningLogs : (Array.isArray(data?.cleaning_logs) ? data.cleaning_logs : []));
    const auditLogsList = normalizeItemsList(Array.isArray(data?.auditLogs) ? data.auditLogs : (Array.isArray(data?.system_logs) ? data.system_logs : []));
    const chatChannelsList = normalizeItemsList(Array.isArray(data?.chatChannels) ? data.chatChannels : (Array.isArray(data?.chat_channels) ? data.chat_channels : (realtimeState.chatChannels || [])));
    const chatMessagesList = normalizeItemsList(Array.isArray(data?.chatMessages) ? data.chatMessages : (Array.isArray(data?.chat_messages) ? data.chat_messages : (realtimeState.chatMessages || [])));

    return {
      buildings: buildingsList,
      rooms: roomsList,
      meetingRooms: meetingRoomsList,
      meeting_rooms: meetingRoomsList,
      roomCapacityRates: roomCapacityRatesList,
      room_capacity_rates: roomCapacityRatesList,
      breakfastMenuItems: breakfastMenuItemsList,
      breakfast_menu_items: breakfastMenuItemsList,
      breakfastOrders: breakfastOrdersList,
      breakfast_orders: breakfastOrdersList,
      transactions: transactionsList,
      users: usersList,
      maintenances: maintenancesList,
      qcInspections: qcInspectionsList,
      qc_inspections: qcInspectionsList,
      cleaningLogs: cleaningLogsList,
      cleaning_logs: cleaningLogsList,
      workSessions: workSessionsList,
      work_sessions: workSessionsList,
      auditLogs: auditLogsList,
      system_logs: auditLogsList,
      appSettings: appSettingsList,
      app_settings: appSettingsList,
      chatChannels: chatChannelsList,
      chat_channels: chatChannelsList,
      chatMessages: chatMessagesList,
      chat_messages: chatMessagesList,
    };
  }

  // Endpoint Auto-Provisioning: Otomatis Membuat Sheet & Menyusun Header Table
  app.post("/api/sheets/auto-provision", async (req, res) => {
    const targetUrl = (req.body?.webAppUrl || activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "").trim();
    const populateData = Boolean(req.body?.populateData);
    const customData = req.body?.data || serverDatabaseCache || {};
    const formattedData = formatDatabaseForSpreadsheet(customData);

    if (!targetUrl) {
      return res.status(400).json({
        ok: false,
        error: "URL Web App Google Apps Script belum dikonfigurasi.",
      });
    }

    try {
      const payload = {
        action: "AUTO_PROVISION",
        schema: APP_DATABASE_SCHEMA,
        populateData,
        data: populateData ? formattedData : {},
        spreadsheetId: activeSheetsConfig.sheetId || undefined,
        timestamp: new Date().toISOString(),
      };

      let response = await fetchGoogleAppsScript(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });

      // Jika gagal dan menyertakan populateData, coba sekali lagi secara ringan (hanya struktur sheet & header)
      if (!response.ok && populateData) {
        try {
          const lightweightPayload = {
            action: "AUTO_PROVISION",
            schema: APP_DATABASE_SCHEMA,
            populateData: false,
            data: {},
            spreadsheetId: activeSheetsConfig.sheetId || undefined,
            timestamp: new Date().toISOString(),
          };
          const retryResp = await fetchGoogleAppsScript(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(lightweightPayload),
          });
          if (retryResp.ok) {
            response = retryResp;
          }
        } catch (_) {}
      }

      const text = await response.text().catch(() => "");

      if (!response.ok) {
        if (response.status === 403 || text.includes("accounts.google.com") || text.includes("ServiceLogin")) {
          return res.status(200).json({
            ok: false,
            isForbidden: true,
            error: "HTTP 403 Forbidden: Akses Web App ditolak. Pastikan deploy diatur ke 'Anyone' (Siapa saja).",
          });
        }

        if (response.status === 500) {
          let diagnostic = "Google Apps Script mengalami kendala saat inisialisasi tabel.";
          if (text.includes("coordinates") || text.includes("dimensions")) {
            diagnostic = "Jumlah kolom pada tabel melebihi batas default 26 kolom Google Sheets. Salin dan perbarui kode Google Apps Script Versi 3.0 dari tab Panduan & Kode Script yang telah dilengkapi fitur auto-expand dimensi kolom.";
          } else if (text.includes("Script function not found")) {
            diagnostic = "Fungsi doPost tidak ditemukan di Google Apps Script Anda. Pasang kode terbaru di Extensions > Apps Script.";
          } else {
            diagnostic = "Google Apps Script mengembalikan HTTP 500. Silakan salin kode Apps Script versi terbaru dari tab 'Panduan & Kode Script' pada menu Integrasi Spreadsheet, lalu buat New Deployment.";
          }
          return res.status(200).json({
            ok: false,
            is500: true,
            needsScriptUpdate: true,
            error: diagnostic,
            rawError: text.slice(0, 300),
          });
        }

        return res.status(200).json({
          ok: false,
          error: `HTTP ${response.status}: ${response.statusText || "Gagal menghubungi Google Apps Script"}`,
          rawError: text.slice(0, 200),
        });
      }

      let resJson: any = null;
      try {
        resJson = JSON.parse(text);
      } catch (_) {
        if (text.includes("accounts.google.com") || text.includes("ServiceLogin")) {
          return res.status(200).json({
            ok: false,
            isForbidden: true,
            error: "HTTP 403 Forbidden: Google Apps Script meminta login. Pastikan deploy diatur ke 'Anyone'.",
          });
        }
        resJson = {
          status: "success",
          message: "Perintah auto-provisioning berhasil dikirim ke Google Apps Script.",
          raw: text,
        };
      }

      // Broadcast update ke client
      broadcastRealtimeEvent("database:sync", { action: "auto-provision", timestamp: Date.now() });

      res.json({
        ok: true,
        message: "Inisialisasi otomatis lembar kerja & header berhasil dijalankan!",
        details: resJson,
        schema: APP_DATABASE_SCHEMA,
      });
    } catch (err: any) {
      console.warn("Gagal menjalankan auto-provisioning:", err?.message || err);
      res.status(200).json({
        ok: false,
        error: `Gagal melakukan auto-provisioning: ${err?.message || "Kesalahan koneksi"}`,
      });
    }
  });

  // 3. Endpoint BACA DATABASE LANGSUNG DARI GOOGLE SPREADSHEET (GET)
  app.get(["/api/sheets/database", "/api/database"], async (req, res) => {
    const targetUrl = activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL;
    const forceRefresh = req.query?.refresh === "true";

    // JIKA CACHE SERVER SUDAH ADA DAN TIDAK DIMINTA REFRESH:
    // Kembalikan langsung dari server cache dalam < 1ms agar respons instan dan tidak membebani limit Google Apps Script
    if (serverDatabaseCache && Array.isArray(serverDatabaseCache.buildings) && serverDatabaseCache.buildings.length > 0 && !forceRefresh) {
      const fullFormatted = formatDatabaseForSpreadsheet(serverDatabaseCache);
      return res.json({
        status: "cached",
        message: "Data dimuat instan dari cache database server.",
        data: fullFormatted,
        source: "server_cache",
        updatedAt: new Date().toISOString(),
      });
    }

    if (!targetUrl) {
      if (serverDatabaseCache) {
        return res.json({
          status: "cached",
          message: "Google Spreadsheet belum terhubung. Menggunakan data tersimpan di server.",
          data: formatDatabaseForSpreadsheet(serverDatabaseCache),
        });
      }
      return res.status(200).json({
        status: "unconfigured",
        message: "Google Spreadsheet belum dikonfigurasi.",
        data: null,
      });
    }

    try {
      const fetchRes = await fetchGoogleAppsScript(targetUrl, {
        method: "GET",
      });

      if (!fetchRes.ok) {
        if (fetchRes.status === 403) {
          throw new Error("HTTP 403 Forbidden: Akses ditolak oleh Google Apps Script. Pastikan opsi 'Who has access' (Siapa yang memiliki akses) saat deploy Web App telah dipilih 'Anyone' (Siapa saja).");
        }
        throw new Error(`HTTP Error dari Google Spreadsheet: ${fetchRes.status} ${fetchRes.statusText}`);
      }

      const text = await fetchRes.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        if (text.includes("accounts.google.com") || text.includes("ServiceLogin") || text.includes("403 Forbidden")) {
          throw new Error("HTTP 403 Forbidden: Google Apps Script meminta autentikasi akun Google. Pastikan Web App di-deploy dengan opsi 'Execute as: Me' dan 'Who has access: Anyone'.");
        }
        throw new Error(`Respon Google Spreadsheet tidak valid: ${text.slice(0, 100)}`);
      }

      const rawSheetData = json.data || json;

      if (json.status === "error" || (rawSheetData && rawSheetData.status === "error") || (rawSheetData && rawSheetData.message && !Array.isArray(rawSheetData.buildings))) {
        const errorMsg = rawSheetData?.message || json?.message || "Google Apps Script mengembalikan status error";
        console.warn("Peringatan Google Apps Script:", errorMsg);
        if (serverDatabaseCache && Array.isArray(serverDatabaseCache.buildings) && serverDatabaseCache.buildings.length > 0) {
          return res.json({
            status: "cached",
            message: `Menggunakan cache server (${errorMsg})`,
            data: serverDatabaseCache,
            source: "server_cache",
            updatedAt: new Date().toISOString(),
          });
        }
        throw new Error(errorMsg);
      }

      const sheetData: any = typeof rawSheetData === "object" && rawSheetData !== null ? { ...rawSheetData } : {};

      // Bersihkan seluruh sheet konflik (seperti users_conflict...) agar tidak mencemari memori & aplikasi
      for (const k of Object.keys(sheetData)) {
        if (k.toLowerCase().includes("conflict")) {
          delete sheetData[k];
        }
      }

      // Pastikan seluruh tabel terdefinisi sebagai array jika kosong/baru header saja
      const expectedArrayTables = [
        "buildings", "rooms", "meeting_rooms", "room_capacity_rates",
        "breakfast_menu_items", "transactions", "users", "maintenances",
        "qc_inspections", "breakfast_orders", "work_sessions", "system_logs"
      ];
      for (const tKey of expectedArrayTables) {
        if (!Array.isArray(sheetData[tKey])) {
          sheetData[tKey] = [];
        }
      }

      // Pastikan tabel rooms hanya berisi kamar hunian murni (bukan fasilitas ruang pertemuan/aula yang sudah ada di meeting_rooms)
      if (Array.isArray(sheetData.rooms)) {
        sheetData.rooms = sheetData.rooms.filter((r: any) => {
          if (!r) return false;
          const b = (r.building || r.gedung || "").toLowerCase();
          const t = (r.type || r.room_type || r.roomType || "").toLowerCase();
          const id = (r.id || "").toLowerCase();
          if (id.startsWith("mr-")) return false;
          if (b.includes("pertemuan") || b.includes("aula") || b.includes("serbaguna")) return false;
          if (t.includes("pertemuan") || t.includes("aula") || t.includes("serbaguna")) return false;
          return true;
        });
      }

      // Update cache lokal di server hanya jika data memiliki isi valid
      if (Array.isArray(sheetData.buildings) && sheetData.buildings.length > 0) {
        serverDatabaseCache = sheetData;
        try {
          fs.writeFileSync(serverDbCachePath, JSON.stringify(sheetData, null, 2), "utf-8");
        } catch (_) {}
      } else if (!serverDatabaseCache) {
        serverDatabaseCache = sheetData;
      }

      res.json({
        status: "success",
        source: "google_spreadsheet",
        data: sheetData,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      const is403 = String(err?.message || "").includes("403");
      console.warn(`[Google Sheets] ${is403 ? "Izin akses ditolak (403 Forbidden)" : "Peringatan koneksi"}:`, err?.message || err);

      const helpMessage = is403 
        ? "Google Apps Script mengembalikan HTTP 403 Forbidden. Pastikan opsi 'Who has access' (Siapa yang memiliki akses) pada Deploy Web App disetel ke 'Anyone' (Siapa saja). Menggunakan data cadangan server..."
        : `Koneksi Google Spreadsheet bermasalah: ${err?.message || "Koneksi terputus"}. Menggunakan data cadangan server...`;

      // Selalu kembalikan status 200 dengan data cache/fallback agar aplikasi tidak pernah mengalami crash atau 502
      if (serverDatabaseCache) {
        return res.status(200).json({
          status: "fallback",
          source: "server_cache",
          isForbidden: is403,
          warning: helpMessage,
          data: serverDatabaseCache,
        });
      }

      // Jika cache belum ada sama sekali di server, berikan data aman
      const fallbackData = {
        buildings: [],
        rooms: [],
        transactions: [],
        users: [],
      };

      res.status(200).json({
        status: "fallback",
        source: "empty_fallback",
        isForbidden: is403,
        warning: helpMessage,
        data: fallbackData,
      });
    }
  });

  // Antrean eksekusi ke Google Apps Script agar berjalan single-flight (tidak saling bertabrakan / limit konkurensi)
  let isPushingToSheets = false;
  let pendingSheetPush: { targetUrl: string; formattedPayload: any } | null = null;

  async function queueSpreadsheetPush(targetUrl: string, formattedPayload: any) {
    if (isPushingToSheets) {
      // Coalesce payload: selalu simpan data paling mutakhir untuk dieksekusi setelah giliran selesai
      pendingSheetPush = { targetUrl, formattedPayload };
      return;
    }

    isPushingToSheets = true;
    try {
      const sheetRes = await fetchGoogleAppsScript(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(formattedPayload),
      });
      const text = await sheetRes.text().catch(() => "");
      console.log(`[Google Sheets Background Push] Status HTTP: ${sheetRes.status}, preview: ${text.slice(0, 80)}`);
    } catch (err: any) {
      console.warn("[Google Sheets Background Push] Peringatan koneksi:", err?.message || err);
    } finally {
      isPushingToSheets = false;
      if (pendingSheetPush) {
        const next = pendingSheetPush;
        pendingSheetPush = null;
        setTimeout(() => {
          queueSpreadsheetPush(next.targetUrl, next.formattedPayload).catch(() => {});
        }, 1200);
      }
    }
  }

  // 4. Endpoint SIMPAN / SINKRONISASI DATABASE KE GOOGLE SPREADSHEET (POST)
  app.post(["/api/sheets/database", "/api/database"], async (req, res) => {
    const targetUrl = (req.body?.webAppUrl || activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "https://script.google.com/macros/s/AKfycby9Tok8-zgcVsTuXfQBDA0prmRSpUs9kxpeyczsw9SRVjwZBEk6Y8st3tBv7LK7j_X6/exec").trim();
    const payload = req.body;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Payload database tidak valid" });
    }

    if (req.body?.webAppUrl && req.body.webAppUrl !== activeSheetsConfig.webAppUrl) {
      activeSheetsConfig.webAppUrl = req.body.webAppUrl;
      activeSheetsConfig.isConfigured = true;
      try {
        fs.writeFileSync(sheetsConfigFilePath, JSON.stringify(activeSheetsConfig, null, 2), "utf-8");
      } catch (_) {}
    }

    // Normalisasi konsistensi master gedung dan unit kamar
    if (Array.isArray(payload.buildings) && Array.isArray(payload.rooms)) {
      const lodgingBlds = payload.buildings.filter((b: any) => !b.category || b.category === 'PENGINAPAN');
      // Pastikan payload.rooms hanya berisi kamar hunian (bukan Ruang Pertemuan / Aula yang sudah ada di sheet meeting_rooms)
      payload.rooms = payload.rooms.filter((r: any) => {
        if (!r) return false;
        const b = (r.building || "").toLowerCase();
        const t = (r.type || "").toLowerCase();
        const id = (r.id || "").toLowerCase();
        if (id.startsWith("mr-")) return false;
        if (b.includes("pertemuan") || b.includes("aula") || b.includes("serbaguna")) return false;
        if (t.includes("pertemuan") || t.includes("aula") || t.includes("serbaguna")) return false;
        return true;
      }).map((r: any) => {
        if (!r) return r;
        const matched = lodgingBlds.find((b: any) => {
          const bName = (b.name || '').toLowerCase().trim();
          const rBld = (r.building || '').toLowerCase().trim();
          if (rBld && rBld === bName) return true;
          const bCode = (b.code || '').toUpperCase().trim();
          const rNum = (r.roomNumber || '').toUpperCase().trim();
          if (bCode && (rNum.startsWith(`${bCode}-`) || rNum.startsWith(`${bCode} `))) return true;
          const getBase = (s: string) => s.replace(/\s*\([^)]*\)/g, '').toLowerCase().trim();
          if (getBase(b.name || '') === getBase(r.building || '')) return true;
          return false;
        });
        if (matched && r.building !== matched.name) {
          return { ...r, building: matched.name, buildingId: matched.id };
        }
        return r;
      });

      payload.buildings = payload.buildings.map((b: any) => {
        if (b.category === 'SERBAGUNA' || b.category === 'RUANG_PERTEMUAN') {
          return { ...b, totalRooms: 0 };
        }
        const bName = (b.name || '').toLowerCase().trim();
        const bCode = (b.code || '').toUpperCase().trim();
        const getBase = (s: string) => s.replace(/\s*\([^)]*\)/g, '').toLowerCase().trim();
        const bBase = getBase(b.name || '');

        const actualCount = payload.rooms.filter((r: any) => {
          const rBld = (r.building || '').toLowerCase().trim();
          if (rBld === bName) return true;
          const rNum = (r.roomNumber || '').toUpperCase().trim();
          if (bCode && (rNum.startsWith(`${bCode}-`) || rNum.startsWith(`${bCode} `))) return true;
          if (bBase && getBase(r.building || '') === bBase) return true;
          return false;
        }).length;

        let capDesc = b.capacityDesc || '';
        if (/^\d+\s*Kamar/i.test(capDesc.trim()) && actualCount > 0) {
          capDesc = capDesc.trim().replace(/^\d+/, String(actualCount));
        }

        return {
          ...b,
          totalRooms: actualCount > 0 ? actualCount : (b.totalRooms || 0),
          capacityDesc: capDesc
        };
      });
    }

    // Selalu simpan ke server database cache secara instan (1ms)
    serverDatabaseCache = payload;
    try {
      fs.writeFileSync(serverDbCachePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (_) {}

    // Broadcast ke seluruh klien real-time bahwa database telah diperbarui
    broadcastRealtimeEvent("database:sync", { timestamp: Date.now(), db: serverDatabaseCache }, req.body?.clientId);

    if (!targetUrl) {
      return res.json({
        ok: true,
        status: "saved_server_only",
        message: "Database disimpan di server (Google Spreadsheet belum dikonfigurasi).",
      });
    }

    try {
      const formattedData = formatDatabaseForSpreadsheet(payload);

      // Bangun daftar operasi BATCH_OPERATIONS untuk eksekusi handal dan cepat di Google Apps Script
      const operations: Array<{ action: string; sheet: string; data: any[] }> = [];
      const tableMap: Record<string, string> = {
        buildings: "buildings",
        rooms: "rooms",
        meeting_rooms: "meeting_rooms",
        room_capacity_rates: "room_capacity_rates",
        breakfast_menu_items: "breakfast_menu_items",
        transactions: "transactions",
        users: "users",
        maintenances: "maintenances",
        qc_inspections: "qc_inspections",
        breakfast_orders: "breakfast_orders",
        cleaning_logs: "cleaning_logs",
        work_sessions: "work_sessions",
        app_settings: "app_settings",
        system_logs: "system_logs",
        chat_channels: "chat_channels",
        chat_messages: "chat_messages",
      };

      for (const [key, sheetName] of Object.entries(tableMap)) {
        if (formattedData[key] !== undefined || formattedData[sheetName] !== undefined) {
          const tableData = formattedData[sheetName] !== undefined ? formattedData[sheetName] : formattedData[key];
          operations.push({
            action: "WRITE",
            sheet: sheetName,
            data: Array.isArray(tableData) ? tableData : (tableData ? [tableData] : []),
          });
        }
      }

      const batchPayload = {
        action: "BATCH_OPERATIONS",
        timestamp: new Date().toISOString(),
        operations,
        spreadsheetId: activeSheetsConfig.sheetId || undefined,
      };

      const isExplicitSync = req.query?.sync === "true";
      if (!isExplicitSync) {
        // NON-BLOCKING: Jadwalkan push ke Google Spreadsheet via BATCH_OPERATIONS di antrean latar belakang
        queueSpreadsheetPush(targetUrl, batchPayload);

        return res.json({
          ok: true,
          status: "success",
          source: "server_cache",
          message: "Data berhasil disimpan instan ke server database dan dijadwalkan sinkron ke Google Spreadsheet.",
          updatedAt: new Date().toISOString(),
        });
      }

      // Jika sync=true (misal dari tombol 'Ekspor ke Spreadsheet' di menu integrasi), tunggu respons selesai
      const sheetRes = await fetchGoogleAppsScript(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(batchPayload),
      });

      const text = await sheetRes.text().catch(() => "");
      let sheetJson: any = null;
      try {
        sheetJson = JSON.parse(text);
      } catch (_) {
        sheetJson = { status: sheetRes.ok ? "success" : "warning", raw: text };
      }

      res.json({
        ok: true,
        status: sheetRes.ok ? "success" : "warning",
        source: "google_spreadsheet",
        message: sheetRes.ok 
          ? "Data seluruh 13 tabel berhasil disimpan permanen ke Google Spreadsheet!" 
          : `Tersimpan di server, tetapi Google Spreadsheet merespons status ${sheetRes.status}`,
        sheetResponse: sheetJson,
      });
    } catch (err: any) {
      console.warn("Gagal push ke Google Spreadsheet:", err?.message || err);
      res.json({
        ok: true,
        status: "warning",
        warning: `Tersimpan di server, tetapi gagal push ke Spreadsheet: ${err?.message}`,
      });
    }
  });

  // 5. Endpoint BATCH OPERATIONS UNTUK SPREADSHEET (POST)
  app.post("/api/sheets/batch", async (req, res) => {
    const targetUrl = (req.body?.webAppUrl || activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "").trim();
    const operations = req.body?.operations;

    if (!Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ ok: false, error: "Daftar operasi batch (operations) tidak valid atau kosong" });
    }

    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: "URL Web App Google Apps Script belum dikonfigurasi." });
    }

    // Perbarui serverDatabaseCache untuk setiap operasi WRITE agar memori server langsung sinkron
    if (serverDatabaseCache && typeof serverDatabaseCache === "object") {
      let cacheUpdated = false;
      for (const op of operations) {
        if ((op.action === "WRITE" || op.action === "SAVE") && op.sheet && Array.isArray(op.data)) {
          const sheetKey = String(op.sheet);
          const camelKey = sheetKey.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
          serverDatabaseCache[sheetKey] = op.data;
          serverDatabaseCache[camelKey] = op.data;
          cacheUpdated = true;
        }
      }
      if (cacheUpdated) {
        try {
          fs.writeFileSync(serverDbCachePath, JSON.stringify(serverDatabaseCache, null, 2), "utf-8");
        } catch (_) {}
      }
    }

    try {
      const batchPayload = {
        action: "BATCH_OPERATIONS",
        timestamp: new Date().toISOString(),
        operations,
        spreadsheetId: activeSheetsConfig.sheetId || undefined,
      };

      const resp = await fetchGoogleAppsScript(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(batchPayload),
      });

      const text = await resp.text().catch(() => "");
      let jsonRes: any = null;
      try {
        jsonRes = JSON.parse(text);
      } catch (_) {
        jsonRes = { status: resp.ok ? "success" : "error", raw: text };
      }

      res.json({
        ok: resp.ok,
        status: resp.ok ? "success" : "error",
        results: jsonRes?.results || jsonRes,
        executedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn("Gagal mengeksekusi batch operations ke Google Spreadsheet:", err?.message || err);
      res.status(500).json({
        ok: false,
        error: err?.message || "Kesalahan koneksi saat mengeksekusi batch operations",
      });
    }
  });

  // Helper pemetaan kunci tabel untuk camelCase dan snake_case
  function getTableKeys(rawSheet: string): { snakeKey: string; camelKey: string } {
    const norm = String(rawSheet || "").trim();
    const snake = norm.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/__+/g, "_");
    const camel = norm.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    return { snakeKey: snake, camelKey: camel };
  }

  function upsertRecordInCache(rawSheet: string, record: any): boolean {
    if (!serverDatabaseCache || typeof serverDatabaseCache !== "object") {
      serverDatabaseCache = {};
    }
    const { snakeKey, camelKey } = getTableKeys(rawSheet);
    const id = record?.id || record?.code || record?.no_kamar || record?.roomNumber;
    if (!id && !record) return false;

    let list: any[] = [];
    if (Array.isArray(serverDatabaseCache[snakeKey])) {
      list = [...serverDatabaseCache[snakeKey]];
    } else if (Array.isArray(serverDatabaseCache[camelKey])) {
      list = [...serverDatabaseCache[camelKey]];
    }

    const idStr = String(id || "").trim();
    const existingIndex = list.findIndex((item) => {
      if (!item) return false;
      const itemId = String(item.id || item.code || item.no_kamar || item.roomNumber || "").trim();
      return itemId && idStr && itemId === idStr;
    });

    const normalizedRecord = normalizeItemsList([record])[0] || record;
    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...normalizedRecord };
    } else {
      list = [normalizedRecord, ...list];
    }

    serverDatabaseCache[snakeKey] = list;
    serverDatabaseCache[camelKey] = list;

    try {
      fs.writeFileSync(serverDbCachePath, JSON.stringify(serverDatabaseCache, null, 2), "utf-8");
    } catch (_) {}

    return true;
  }

  function deleteRecordInCache(rawSheet: string, recordId: string): boolean {
    if (!serverDatabaseCache || typeof serverDatabaseCache !== "object") return false;
    const { snakeKey, camelKey } = getTableKeys(rawSheet);
    const idStr = String(recordId || "").trim();
    if (!idStr) return false;

    let list: any[] = [];
    if (Array.isArray(serverDatabaseCache[snakeKey])) {
      list = [...serverDatabaseCache[snakeKey]];
    } else if (Array.isArray(serverDatabaseCache[camelKey])) {
      list = [...serverDatabaseCache[camelKey]];
    } else {
      return false;
    }

    const initialLen = list.length;
    list = list.filter((item) => {
      if (!item) return false;
      const itemId = String(item.id || item.code || item.no_kamar || item.roomNumber || "").trim();
      return itemId !== idStr;
    });

    serverDatabaseCache[snakeKey] = list;
    serverDatabaseCache[camelKey] = list;

    try {
      fs.writeFileSync(serverDbCachePath, JSON.stringify(serverDatabaseCache, null, 2), "utf-8");
    } catch (_) {}

    return list.length !== initialLen;
  }

  // 6. Endpoint UPSERT SATU REKAMAN LANGSUNG (POST /api/sheets/upsert)
  app.post("/api/sheets/upsert", async (req, res) => {
    const rawSheet = req.body?.sheet || req.body?.table || "";
    const record = req.body?.record || req.body?.data?.[0] || req.body?.data;
    const targetUrl = (req.body?.webAppUrl || activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "").trim();

    if (!rawSheet || !record) {
      return res.status(400).json({ ok: false, error: "Nama lembar (sheet) dan data record diperlukan" });
    }

    // 1. Simpan ke database server cache secara instan (0ms)
    upsertRecordInCache(rawSheet, record);

    // 2. Siarkan pembaruan database seketika ke seluruh perangkat & akun yang sedang login via SSE
    broadcastRealtimeEvent("database:sync", {
      action: "upsert",
      sheet: rawSheet,
      record,
      timestamp: Date.now(),
      db: serverDatabaseCache,
    }, req.body?.clientId);

    // 3. Teruskan secara asinkron ke Google Apps Script di latar belakang
    if (targetUrl) {
      const payload = {
        action: "UPSERT_RECORD",
        sheet: rawSheet,
        table: rawSheet,
        record,
        data: [record],
        timestamp: new Date().toISOString(),
      };
      fetchGoogleAppsScript(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      }).catch((err) => {
        console.warn("[Google Sheets Upsert] Latar belakang peringatan:", err?.message || err);
      });
    }

    res.json({
      ok: true,
      status: "success",
      message: "Data berhasil disimpan instan di server dan disinkronkan ke seluruh perangkat",
      record,
    });
  });

  // 7. Endpoint DELETE SATU REKAMAN LANGSUNG (POST /api/sheets/delete)
  app.post("/api/sheets/delete", async (req, res) => {
    const rawSheet = req.body?.sheet || req.body?.table || "";
    const recordId = req.body?.id || req.body?.record?.id || "";
    const targetUrl = (req.body?.webAppUrl || activeSheetsConfig.webAppUrl || process.env.GOOGLE_SHEETS_WEBAPP_URL || "").trim();

    if (!rawSheet || !recordId) {
      return res.status(400).json({ ok: false, error: "Nama lembar (sheet) dan ID record diperlukan" });
    }

    // 1. Hapus dari database server cache secara instan (0ms)
    deleteRecordInCache(rawSheet, recordId);

    // 2. Siarkan penghapusan seketika ke seluruh perangkat & akun yang sedang login via SSE
    broadcastRealtimeEvent("database:sync", {
      action: "delete",
      sheet: rawSheet,
      id: recordId,
      timestamp: Date.now(),
      db: serverDatabaseCache,
    }, req.body?.clientId);

    // 3. Teruskan secara asinkron ke Google Apps Script di latar belakang
    if (targetUrl) {
      const payload = {
        action: "DELETE_RECORD",
        sheet: rawSheet,
        table: rawSheet,
        id: recordId,
        timestamp: new Date().toISOString(),
      };
      fetchGoogleAppsScript(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      }).catch((err) => {
        console.warn("[Google Sheets Delete] Latar belakang peringatan:", err?.message || err);
      });
    }

    res.json({
      ok: true,
      status: "success",
      message: "Data berhasil dihapus dari database server dan disinkronkan ke seluruh perangkat",
      id: recordId,
    });
  });

  // Server-Sent Events (SSE) Stream for instant real-time updates
  app.get("/api/realtime/stream", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    sseClients.add(res);

    // Send initial authoritative state immediately upon connect
    const now = Date.now();
    for (const [key, p] of Object.entries(realtimeState.presences)) {
      if (now - p.lastSeenMs > 120000) {
        delete realtimeState.presences[key];
      }
    }

    const initPayload = JSON.stringify({
      type: "init",
      payload: {
        presences: Object.values(realtimeState.presences),
        workSessions: realtimeState.workSessions,
        chatChannels: realtimeState.chatChannels,
        chatMessages: realtimeState.chatMessages,
        sheetsConfig: activeSheetsConfig,
        databaseConfig: activeSheetsConfig,
      },
      timestamp: Date.now(),
    });
    res.write(`data: ${initPayload}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch (_) {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 10000);

    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  app.get("/api/realtime/state", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    const now = Date.now();
    for (const [key, p] of Object.entries(realtimeState.presences)) {
      if (now - p.lastSeenMs > 120000) {
        delete realtimeState.presences[key];
      }
    }
    res.json({
      ok: true,
      presences: Object.values(realtimeState.presences),
      workSessions: realtimeState.workSessions,
      chatChannels: realtimeState.chatChannels,
      chatMessages: realtimeState.chatMessages,
      timestamp: Date.now(),
    });
  });

  app.post("/api/session/auto-checkout", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    let data = req.body;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (_) {}
    }

    const { sessionId, userId, logoutTime, durationSeconds } = data || {};
    if (!sessionId && !userId) {
      res.json({ ok: true, message: "No session or user specified" });
      return;
    }

    const now = new Date();
    const resolvedLogoutTime = logoutTime || new Date().toISOString().replace("T", " ").substring(0, 19);

    let updatedSession: any = null;

    realtimeState.workSessions = realtimeState.workSessions.map((s: any) => {
      const isMatch = (sessionId && s.id === sessionId) || (userId && s.userId === userId && s.status === "AKTIF");
      if (isMatch) {
        let diffSec = Number(durationSeconds) || 0;
        if (!diffSec && s.loginTime) {
          const startMs = new Date(s.loginTime.replace(/-/g, "/")).getTime();
          if (!isNaN(startMs)) {
            diffSec = Math.max(1, Math.floor((now.getTime() - startMs) / 1000));
          }
        }
        if (!diffSec) diffSec = s.durationSeconds || 1;

        const hours = Math.floor(diffSec / 3600);
        const minutes = Math.floor((diffSec % 3600) / 60);
        const seconds = diffSec % 60;
        const formatted = `${hours} Jam ${minutes} Menit ${seconds} Detik`;

        updatedSession = {
          ...s,
          status: "SELESAI",
          logoutTime: resolvedLogoutTime,
          durationSeconds: diffSec,
          durationFormatted: formatted,
          notes: s.notes ? `${s.notes} • Auto check-out saat tab/browser ditutup` : "Auto check-out saat tab/browser ditutup",
        };
        return updatedSession;
      }
      return s;
    });

    if (updatedSession) {
      if (serverDatabaseCache && Array.isArray(serverDatabaseCache.workSessions)) {
        const cIdx = serverDatabaseCache.workSessions.findIndex((s: any) => s.id === updatedSession.id);
        if (cIdx >= 0) {
          serverDatabaseCache.workSessions[cIdx] = updatedSession;
        } else {
          serverDatabaseCache.workSessions.unshift(updatedSession);
        }
      }

      if (userId) {
        for (const [key, p] of Object.entries(realtimeState.presences)) {
          if (p.userId === userId) {
            delete realtimeState.presences[key];
          }
        }
        broadcastRealtimeEvent("presence:sync", Object.values(realtimeState.presences));
      }

      broadcastRealtimeEvent("session:upsert", updatedSession);
      triggerAsyncWorkSessionSpreadsheetSync();
    }

    res.json({ ok: true, updated: updatedSession });
  });

  app.post("/api/realtime/event", (req, res) => {
    const { type, payload, clientId } = req.body || {};
    if (!type) {
      res.status(400).json({ error: "Missing event type" });
      return;
    }

    if (type === "presence:heartbeat" && payload?.userId) {
      const key = `${payload.userId}___${clientId || "default"}`;
      realtimeState.presences[key] = {
        ...payload,
        clientId: clientId || "default",
        lastSeenMs: Date.now(),
      };
      broadcastRealtimeEvent("presence:sync", Object.values(realtimeState.presences), clientId);
    } else if (type === "presence:leave" && payload?.userId) {
      for (const [key, p] of Object.entries(realtimeState.presences)) {
        if (p.userId === payload.userId && (!clientId || p.clientId === clientId || payload.allDevices)) {
          delete realtimeState.presences[key];
        }
      }
      broadcastRealtimeEvent("presence:sync", Object.values(realtimeState.presences), clientId);
    } else if (type === "session:upsert" && payload?.id) {
      const idx = realtimeState.workSessions.findIndex((s: any) => s.id === payload.id);
      if (idx >= 0) {
        realtimeState.workSessions[idx] = { ...realtimeState.workSessions[idx], ...payload };
      } else {
        realtimeState.workSessions.unshift(payload);
      }
      // If this session is AKTIF, automatically close any older AKTIF session for the same user across all devices
      if (payload.userId && payload.status === "AKTIF") {
        realtimeState.workSessions = realtimeState.workSessions.map((s: any) => {
          if (s.userId === payload.userId && s.id !== payload.id && s.status === "AKTIF") {
            return {
              ...s,
              status: "SELESAI",
              logoutTime: payload.loginTime || new Date().toISOString().replace("T", " ").substring(0, 19),
              notes: s.notes ? `${s.notes} • Dialihkan karena login di perangkat baru` : "Dialihkan karena login di perangkat baru",
            };
          }
          return s;
        });
      }
      triggerAsyncWorkSessionSpreadsheetSync();
      broadcastRealtimeEvent("session:upsert", payload, clientId);
    } else if (type === "session:sync_bulk" && Array.isArray(payload)) {
      const byId = new Map<string, any>();
      for (const s of realtimeState.workSessions) {
        if (s?.id) byId.set(s.id, s);
      }
      for (const s of payload) {
        if (!s?.id) continue;
        const existing = byId.get(s.id);
        if (!existing) {
          byId.set(s.id, s);
        } else if (existing.status === "SELESAI" && s.status === "AKTIF") {
          // Keep SELESAI so finished sessions never revert to AKTIF
          byId.set(s.id, existing);
        } else {
          byId.set(s.id, { ...existing, ...s });
        }
      }
      realtimeState.workSessions = Array.from(byId.values());
      triggerAsyncWorkSessionSpreadsheetSync();
    } else if (type === "session:clear") {
      realtimeState.workSessions = [];
      triggerAsyncWorkSessionSpreadsheetSync();
      broadcastRealtimeEvent("session:clear", {}, clientId);
    } else if (type === "session:delete" && (payload?.id || payload?.ids)) {
      const idsToDelete = new Set<string>(
        Array.isArray(payload.ids) ? payload.ids : [payload.id].filter(Boolean)
      );
      realtimeState.workSessions = realtimeState.workSessions.filter((s: any) => !idsToDelete.has(s.id));
      if (serverDatabaseCache && Array.isArray(serverDatabaseCache.workSessions)) {
        serverDatabaseCache.workSessions = serverDatabaseCache.workSessions.filter((s: any) => !idsToDelete.has(s.id));
      }
      triggerAsyncWorkSessionSpreadsheetSync();
      broadcastRealtimeEvent("session:delete", payload, clientId);
    } else if (type === "chat:message" && payload?.message?.id) {
      const msg = payload.message;
      const channel = payload.channel;
      if (!realtimeState.chatMessages.some((m: any) => m.id === msg.id)) {
        realtimeState.chatMessages.push(msg);
      }
      if (channel?.id) {
        const cIdx = realtimeState.chatChannels.findIndex((c: any) => c.id === channel.id);
        if (cIdx >= 0) {
          realtimeState.chatChannels[cIdx] = {
            ...realtimeState.chatChannels[cIdx],
            ...channel,
            lastMessage: msg.message,
            lastMessageTime: msg.timeFormatted,
            lastSenderName: msg.senderName,
            updatedAt: new Date().toISOString(),
          };
        } else {
          realtimeState.chatChannels.unshift({
            ...channel,
            lastMessage: msg.message,
            lastMessageTime: msg.timeFormatted,
            lastSenderName: msg.senderName,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      saveChatStorageToDisk();
      broadcastRealtimeEvent("chat:message", { message: msg, channel }, clientId);
    } else if (type === "chat:read" && payload?.channelId && payload?.userId) {
      const { channelId, userId } = payload;
      let readChanged = false;
      realtimeState.chatMessages = realtimeState.chatMessages.map((m: any) => {
        if (m.channelId === channelId && Array.isArray(m.readBy) && !m.readBy.includes(userId)) {
          readChanged = true;
          return { ...m, readBy: [...m.readBy, userId] };
        }
        return m;
      });
      if (readChanged) {
        saveChatStorageToDisk();
      }
      broadcastRealtimeEvent("chat:read", { channelId, userId }, clientId);
    } else if (type === "chat:channel" && payload?.id) {
      const cIdx = realtimeState.chatChannels.findIndex((c: any) => c.id === payload.id);
      if (cIdx >= 0) {
        realtimeState.chatChannels[cIdx] = { ...realtimeState.chatChannels[cIdx], ...payload, updatedAt: new Date().toISOString() };
      } else {
        realtimeState.chatChannels.unshift({ ...payload, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      saveChatStorageToDisk();
      broadcastRealtimeEvent("chat:channel", payload, clientId);
    } else if (type === "chat:clear") {
      const channelId = payload?.channelId;
      if (channelId) {
        realtimeState.chatMessages = realtimeState.chatMessages.filter((m: any) => m.channelId !== channelId);
      } else {
        realtimeState.chatMessages = [];
      }
      saveChatStorageToDisk();
      broadcastRealtimeEvent("chat:clear", { channelId }, clientId);
    } else if (type === "chat:typing" && payload?.channelId && payload?.userId) {
      broadcastRealtimeEvent("chat:typing", payload, clientId);
    } else if (type === "database:sync") {
      if (payload?.db && typeof payload.db === "object") {
        serverDatabaseCache = payload.db;
        try {
          fs.writeFileSync(serverDbCachePath, JSON.stringify(payload.db, null, 2), "utf-8");
        } catch (_) {}
      }
      broadcastRealtimeEvent("database:sync", payload, clientId);
    }

    res.json({ ok: true });
  });

  // =========================================================================
  // REST API PERMANEN UNTUK CHAT MENGAMBANG (CHANNELS & MESSAGES)
  // =========================================================================
  app.get("/api/chat/database", (_req, res) => {
    res.json({
      ok: true,
      channels: realtimeState.chatChannels,
      messages: realtimeState.chatMessages,
      schema: {
        channels: APP_DATABASE_SCHEMA.chat_channels,
        messages: APP_DATABASE_SCHEMA.chat_messages,
      },
      count: {
        channels: realtimeState.chatChannels.length,
        messages: realtimeState.chatMessages.length,
      },
      timestamp: Date.now(),
    });
  });

  app.post("/api/chat/messages", (req, res) => {
    const { message, channel, clientId } = req.body || {};
    if (!message || !message.channelId || !message.message) {
      res.status(400).json({ ok: false, error: "Pesan tidak lengkap" });
      return;
    }

    const now = new Date();
    const finalMsg = {
      id: message.id || `msg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      channelId: message.channelId,
      channelType: message.channelType || (channel?.type || 'GROUP'),
      senderId: message.senderId,
      senderName: message.senderName,
      senderRole: message.senderRole,
      senderDepartment: message.senderDepartment || 'Operasional',
      message: message.message,
      timestamp: message.timestamp || now.toISOString(),
      timeFormatted: message.timeFormatted || now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB',
      priority: message.priority || 'NORMAL',
      isInstruction: Boolean(message.isInstruction),
      readBy: Array.isArray(message.readBy) ? message.readBy : [message.senderId].filter(Boolean),
      replyToId: message.replyToId || undefined,
      replyToSender: message.replyToSender || undefined,
      replyToText: message.replyToText || undefined,
      createdAt: message.createdAt || now.toISOString(),
    };

    if (!realtimeState.chatMessages.some((m: any) => m.id === finalMsg.id)) {
      realtimeState.chatMessages.push(finalMsg);
    }

    if (channel?.id) {
      const cIdx = realtimeState.chatChannels.findIndex((c: any) => c.id === channel.id);
      const chData = {
        ...channel,
        lastMessage: finalMsg.message,
        lastMessageTime: finalMsg.timeFormatted,
        lastSenderName: finalMsg.senderName,
        updatedAt: now.toISOString(),
      };
      if (cIdx >= 0) {
        realtimeState.chatChannels[cIdx] = { ...realtimeState.chatChannels[cIdx], ...chData };
      } else {
        realtimeState.chatChannels.unshift(chData);
      }
    }

    saveChatStorageToDisk();
    broadcastRealtimeEvent("chat:message", { message: finalMsg, channel }, clientId);
    res.json({ ok: true, message: finalMsg });
  });

  app.post("/api/chat/channels", (req, res) => {
    const { channel } = req.body || {};
    if (!channel || !channel.id) {
      res.status(400).json({ ok: false, error: "Data channel tidak lengkap" });
      return;
    }
    const cIdx = realtimeState.chatChannels.findIndex((c: any) => c.id === channel.id);
    if (cIdx >= 0) {
      realtimeState.chatChannels[cIdx] = { ...realtimeState.chatChannels[cIdx], ...channel, updatedAt: new Date().toISOString() };
    } else {
      realtimeState.chatChannels.unshift({ ...channel, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    saveChatStorageToDisk();
    broadcastRealtimeEvent("chat:channel", channel);
    res.json({ ok: true, channel });
  });

  app.post("/api/chat/mark-read", (req, res) => {
    const { channelId, userId } = req.body || {};
    if (channelId && userId) {
      let readChanged = false;
      realtimeState.chatMessages = realtimeState.chatMessages.map((m: any) => {
        if (m.channelId === channelId && Array.isArray(m.readBy) && !m.readBy.includes(userId)) {
          readChanged = true;
          return { ...m, readBy: [...m.readBy, userId] };
        }
        return m;
      });
      if (readChanged) {
        saveChatStorageToDisk();
        broadcastRealtimeEvent("chat:read", { channelId, userId });
      }
    }
    res.json({ ok: true });
  });

  const distPath = path.join(process.cwd(), "dist");
  const distIndex = path.join(distPath, "index.html");
  const rootIndex = path.join(process.cwd(), "index.html");

  const isDevLifecycle = process.env.npm_lifecycle_event === "dev";
  const isStartOrProd =
    !isDevLifecycle &&
    (process.env.NODE_ENV === "production" ||
      process.env.npm_lifecycle_event === "start");

  if (isStartOrProd && !fs.existsSync(distIndex)) {
    try {
      console.log("dist/index.html not found, running Vite build...");
      const { build } = await import("vite");
      await build();
    } catch (err) {
      console.error("Failed to auto-build dist:", err);
    }
  }

  const shouldServeStatic = isStartOrProd && fs.existsSync(distIndex);

  if (!shouldServeStatic) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server: httpServer, // Menyalurkan WebSocket HMR ke Express Server
          clientPort: 443,   // Memaksa port SSL HTTPS untuk Cloud Proxy
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath, { index: false }));
    app.get("*", (req, res, next) => {
      if (fs.existsSync(distIndex)) {
        res.sendFile(distIndex, (err) => {
          if (err && !res.headersSent) {
            if (fs.existsSync(rootIndex)) {
              res.sendFile(rootIndex);
            } else {
              next(err);
            }
          }
        });
      } else if (fs.existsSync(rootIndex)) {
        res.sendFile(rootIndex);
      } else {
        res.status(404).send("Application index.html not found. Please run npm run build.");
      }
    });
  }

  // Global Express error handler to prevent crashing on missing files
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Express unhandled error:", err?.message || err);
    if (!res.headersSent) {
      res.status(err?.status || 500).json({ error: "Server Error", message: err?.message || "Internal Server Error" });
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();