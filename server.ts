import dotenv from 'dotenv';
dotenv.config();

import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createHttpServer } from "http";
import { query as pgQuery, updatePoolConfig } from "./src/db/db.ts";

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
  const aivenConfigFilePath = path.join(process.cwd(), "aiven_config.json");
  const envFilePath = path.join(process.cwd(), ".env");

  if (!process.env.DATABASE_URL && fs.existsSync(aivenConfigFilePath)) {
    try {
      const aivenCfg = JSON.parse(fs.readFileSync(aivenConfigFilePath, "utf-8"));
      if (aivenCfg && aivenCfg.databaseUrl) {
        process.env.DATABASE_URL = aivenCfg.databaseUrl;
        updatePoolConfig(aivenCfg.databaseUrl);
      }
    } catch (_) {}
  }

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

  // =========================================================================
  // AIVEN POSTGRESQL API ENDPOINTS (MIGRATION FROM GOOGLE SHEETS)
  // =========================================================================

  async function ensureAndPopulateRelationalTables(db: any) {
    if (!process.env.DATABASE_URL || !db || typeof db !== 'object') return;
    try {
      await pgQuery(`
        CREATE TABLE IF NOT EXISTS app_kv (
          key VARCHAR(255) PRIMARY KEY,
          value TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS buildings (
          id VARCHAR(100) PRIMARY KEY,
          name VARCHAR(255),
          code VARCHAR(100),
          floors INTEGER,
          total_rooms INTEGER,
          capacity_desc VARCHAR(255),
          category VARCHAR(50),
          status VARCHAR(50),
          description TEXT,
          updated_at VARCHAR(100),
          data JSONB
        );
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS name VARCHAR(255);
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS floors INTEGER;
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS total_rooms INTEGER;
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS capacity_desc VARCHAR(255);
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS category VARCHAR(50);
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE buildings ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE buildings ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS rooms (
          id VARCHAR(100) PRIMARY KEY,
          room_number VARCHAR(100),
          building VARCHAR(255),
          building_id VARCHAR(100),
          floor INTEGER,
          type VARCHAR(100),
          bed_type VARCHAR(100),
          capacity VARCHAR(100),
          capacity_number INTEGER,
          price_per_night NUMERIC,
          status VARCHAR(50),
          qc_status VARCHAR(50),
          facilities TEXT,
          notes TEXT,
          active_tx_id VARCHAR(100),
          active_maint_id VARCHAR(100),
          updated_at VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE rooms ALTER COLUMN capacity TYPE VARCHAR(100) USING capacity::TEXT;
          EXCEPTION WHEN OTHERS THEN NULL;
          END;
        END $$;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_number VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS building VARCHAR(255);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS building_id VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor INTEGER;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS type VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS bed_type VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS capacity VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS capacity_number INTEGER;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS price_per_night NUMERIC;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS qc_status VARCHAR(50);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS facilities TEXT;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active_tx_id VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active_maint_id VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE rooms ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS transactions (
          id VARCHAR(100) PRIMARY KEY,
          room_id VARCHAR(100),
          room_number VARCHAR(100),
          building VARCHAR(100),
          guest_name VARCHAR(255),
          guest_type VARCHAR(50),
          nik_ktp VARCHAR(50),
          kloter VARCHAR(50),
          phone VARCHAR(50),
          email VARCHAR(100),
          category VARCHAR(50),
          status VARCHAR(50),
          start_date VARCHAR(50),
          duration INTEGER,
          duration_unit VARCHAR(50),
          price_per_night NUMERIC,
          total_amount NUMERIC,
          payment_status VARCHAR(50),
          payment_method VARCHAR(100),
          payment_date VARCHAR(50),
          payment_note TEXT,
          kwitansi_no VARCHAR(100),
          is_paid BOOLEAN,
          paid_amount NUMERIC,
          dp_amount NUMERIC,
          remaining_amount NUMERIC,
          is_group BOOLEAN,
          group_id VARCHAR(100),
          group_type VARCHAR(100),
          group_name VARCHAR(255),
          group_pic VARCHAR(255),
          group_pic_phone VARCHAR(50),
          total_pax INTEGER,
          spk_number VARCHAR(100),
          check_in_time VARCHAR(50),
          check_out_time VARCHAR(50),
          notes TEXT,
          created_user VARCHAR(100),
          created_at VARCHAR(100),
          updated_at VARCHAR(100),
          extended_count INTEGER,
          nomor_porsi VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS room_id VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS room_number VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS building VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS guest_name VARCHAR(255);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS guest_type VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS nik_ktp VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS kloter VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS email VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS start_date VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS duration INTEGER;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS price_per_night NUMERIC;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS total_amount NUMERIC;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_date VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_note TEXT;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS kwitansi_no VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_paid BOOLEAN;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid_amount NUMERIC;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dp_amount NUMERIC;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_group BOOLEAN;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS group_id VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS group_type VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS group_name VARCHAR(255);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS group_pic VARCHAR(255);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS group_pic_phone VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS total_pax INTEGER;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS spk_number VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS check_in_time VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS check_out_time VARCHAR(50);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_user VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS extended_count INTEGER;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS nomor_porsi VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE transactions ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(100) PRIMARY KEY,
          username VARCHAR(100),
          role VARCHAR(100),
          full_name VARCHAR(255),
          department VARCHAR(100),
          assigned_building VARCHAR(100),
          phone VARCHAR(50),
          password VARCHAR(255),
          signature_url TEXT,
          qr_code_url TEXT,
          nip VARCHAR(100),
          email VARCHAR(100),
          status VARCHAR(50),
          updated_at VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_building VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_url TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_code_url TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS nip VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE users ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS maintenances (
          id VARCHAR(100) PRIMARY KEY,
          room_id VARCHAR(100),
          room_number VARCHAR(100),
          building VARCHAR(100),
          category VARCHAR(100),
          issue TEXT,
          description TEXT,
          urgency VARCHAR(50),
          status VARCHAR(50),
          technician VARCHAR(100),
          assigned_technician_id VARCHAR(100),
          assigned_technician_name VARCHAR(255),
          technician_notes TEXT,
          reporter VARCHAR(100),
          report_time VARCHAR(100),
          resolved_time VARCHAR(100),
          updated_at VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS room_id VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS room_number VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS building VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS category VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS issue TEXT;
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS urgency VARCHAR(50);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS technician VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS assigned_technician_id VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS assigned_technician_name VARCHAR(255);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS technician_notes TEXT;
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS reporter VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS report_time VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS resolved_time VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE maintenances ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS qc_inspections (
          id VARCHAR(100) PRIMARY KEY,
          room_number VARCHAR(100),
          inspector VARCHAR(255),
          building VARCHAR(100),
          inspection_date VARCHAR(100),
          status VARCHAR(50),
          score INTEGER,
          notes TEXT,
          updated_at VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS room_number VARCHAR(100);
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS inspector VARCHAR(255);
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS building VARCHAR(100);
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS inspection_date VARCHAR(100);
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS score INTEGER;
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE qc_inspections ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS work_sessions (
          id VARCHAR(100) PRIMARY KEY,
          user_id VARCHAR(100),
          user_name VARCHAR(255),
          data JSONB
        );
        ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS user_id VARCHAR(100);
        ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS user_name VARCHAR(255);
        ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE work_sessions ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS meeting_rooms (
          id VARCHAR(100) PRIMARY KEY,
          name VARCHAR(255),
          code VARCHAR(100),
          category VARCHAR(50),
          building VARCHAR(100),
          floor INTEGER,
          capacity VARCHAR(100),
          capacity_number INTEGER,
          daily_rate NUMERIC,
          session_rate NUMERIC,
          status VARCHAR(50),
          qc_status VARCHAR(50),
          facilities TEXT,
          description TEXT,
          updated_at VARCHAR(100),
          data JSONB
        );
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE meeting_rooms ALTER COLUMN capacity TYPE VARCHAR(100) USING capacity::TEXT;
          EXCEPTION WHEN OTHERS THEN NULL;
          END;
        END $$;
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS name VARCHAR(255);
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS category VARCHAR(50);
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS building VARCHAR(100);
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS floor INTEGER;
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS capacity VARCHAR(100);
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS capacity_number INTEGER;
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS daily_rate NUMERIC;
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS session_rate NUMERIC;
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS qc_status VARCHAR(50);
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS facilities TEXT;
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE meeting_rooms ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS breakfast_orders (
          id VARCHAR(100) PRIMARY KEY,
          room_number VARCHAR(100),
          building VARCHAR(100),
          guest_name VARCHAR(255),
          phone VARCHAR(50),
          transaction_id VARCHAR(100),
          menu_name VARCHAR(255),
          portions INTEGER,
          days INTEGER,
          start_date VARCHAR(50),
          delivery_time VARCHAR(50),
          status VARCHAR(50),
          price_per_portion NUMERIC,
          total_price NUMERIC,
          notes TEXT,
          created_at VARCHAR(100),
          updated_at VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS room_number VARCHAR(100);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS building VARCHAR(100);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS guest_name VARCHAR(255);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS menu_name VARCHAR(255);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS portions INTEGER;
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS days INTEGER;
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS start_date VARCHAR(50);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS delivery_time VARCHAR(50);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS price_per_portion NUMERIC;
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS total_price NUMERIC;
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS created_at VARCHAR(100);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE breakfast_orders ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE breakfast_orders ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS breakfast_menu_items (
          id VARCHAR(100) PRIMARY KEY,
          name VARCHAR(255),
          category VARCHAR(100),
          price NUMERIC,
          description TEXT,
          is_available BOOLEAN,
          allergens VARCHAR(255),
          updated_at VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS name VARCHAR(255);
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS category VARCHAR(100);
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS price NUMERIC;
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS is_available BOOLEAN;
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS allergens VARCHAR(255);
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE breakfast_menu_items ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE breakfast_menu_items ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS room_capacity_rates (
          id VARCHAR(100) PRIMARY KEY,
          room_type VARCHAR(100),
          bed_type VARCHAR(100),
          capacity_pax INTEGER,
          price_per_night NUMERIC,
          description TEXT,
          facilities TEXT,
          is_active BOOLEAN,
          updated_at VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS room_type VARCHAR(100);
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS bed_type VARCHAR(100);
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS capacity_pax INTEGER;
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS price_per_night NUMERIC;
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS facilities TEXT;
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS is_active BOOLEAN;
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE room_capacity_rates ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE room_capacity_rates ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS audit_logs (
          id VARCHAR(100) PRIMARY KEY,
          action VARCHAR(255),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action VARCHAR(255);
        ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS data JSONB;
        ALTER TABLE audit_logs ALTER COLUMN code DROP NOT NULL;

        CREATE TABLE IF NOT EXISTS cleaning_logs (
          id VARCHAR(100) PRIMARY KEY,
          room_number VARCHAR(100),
          building VARCHAR(100),
          petugas_id VARCHAR(100),
          petugas_name VARCHAR(255),
          timestamp VARCHAR(100),
          status VARCHAR(50),
          notes TEXT,
          photo_url TEXT,
          updated_at VARCHAR(100),
          code VARCHAR(100),
          data JSONB
        );
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS room_number VARCHAR(100);
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS building VARCHAR(100);
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS petugas_id VARCHAR(100);
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS petugas_name VARCHAR(255);
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS timestamp VARCHAR(100);
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS status VARCHAR(50);
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS photo_url TEXT;
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS updated_at VARCHAR(100);
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS code VARCHAR(100);
        ALTER TABLE cleaning_logs ADD COLUMN IF NOT EXISTS data JSONB;

        -- Migrasikan seluruh kolom TIMESTAMP/DATE pada seluruh tabel operasional ke VARCHAR(100)
        -- agar aman menerima string tanggal/waktu ISO, format kustom, serta string kosong "" tanpa error DateTimeParseError
        DO $$ 
        DECLARE
          r RECORD;
        BEGIN 
          FOR r IN (
            SELECT table_name, column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name NOT IN ('app_kv')
              AND (data_type LIKE '%timestamp%' OR data_type LIKE '%date%')
          ) LOOP
            BEGIN
              EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE VARCHAR(100) USING %I::TEXT', r.table_name, r.column_name, r.column_name);
            EXCEPTION WHEN OTHERS THEN NULL;
            END;
          END LOOP;
        END $$;

        -- Hapus foreign key constraint yang kaku agar operasi sinkronisasi batch/CRUD tidak tertolak jika urutan data berbeda
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_room_id_fkey;
        ALTER TABLE maintenances DROP CONSTRAINT IF EXISTS maintenances_room_id_fkey;
        ALTER TABLE qc_inspections DROP CONSTRAINT IF EXISTS qc_inspections_room_id_fkey;
        ALTER TABLE cleaning_logs DROP CONSTRAINT IF EXISTS cleaning_logs_room_id_fkey;
        ALTER TABLE cleaning_logs DROP CONSTRAINT IF EXISTS cleaning_logs_meeting_room_id_fkey;
        ALTER TABLE breakfast_orders DROP CONSTRAINT IF EXISTS breakfast_orders_transaction_id_fkey;
        ALTER TABLE breakfast_orders DROP CONSTRAINT IF EXISTS breakfast_orders_menu_id_fkey;
        ALTER TABLE work_sessions DROP CONSTRAINT IF EXISTS work_sessions_user_id_fkey;
        ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_building_id_fkey;
      `);

      // Helper aman parsing tanggal/waktu: jika string kosong atau "-", kembalikan null untuk mencegah error PostgreSQL
      const safeDateOrNull = (v: any): string | null => {
        if (v === null || v === undefined) return null;
        const s = String(v).trim();
        return s === '' || s === '-' || s === 'null' || s === 'undefined' ? null : s;
      };

      const jsonStr = JSON.stringify(db);
      await pgQuery(`
        INSERT INTO app_kv (key, value, updated_at)
        VALUES ('full_database', $1, CURRENT_TIMESTAMP)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;
      `, [jsonStr]);

      // 1. BUILDINGS
      if (Array.isArray(db.buildings)) {
        const bIds = db.buildings.map((b: any) => String(b.id || b.name)).filter(Boolean);
        if (bIds.length > 0) {
          await pgQuery(`DELETE FROM buildings WHERE id NOT IN (${bIds.map((_, i) => `$${i + 1}`).join(', ')})`, bIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM buildings`).catch(() => {});
        }
        for (const b of db.buildings) {
          const id = b.id || b.name;
          if (id) {
            await pgQuery(`
              INSERT INTO buildings (
                id, name, code, floors, total_rooms, capacity_desc, category, status, description, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              ON CONFLICT (id) DO UPDATE SET 
                name = EXCLUDED.name, 
                code = EXCLUDED.code,
                floors = EXCLUDED.floors,
                total_rooms = EXCLUDED.total_rooms,
                capacity_desc = EXCLUDED.capacity_desc,
                category = EXCLUDED.category,
                status = EXCLUDED.status,
                description = EXCLUDED.description,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              b.name || String(id),
              b.code || '',
              Number(b.floors) || 1,
              Number(b.totalRooms ?? b.total_rooms) || 0,
              b.capacityDesc || b.capacity_desc || '',
              b.category || 'PENGINAPAN',
              b.status || 'AKTIF',
              b.description || '',
              b.updatedAt || b.updated_at || new Date().toISOString(),
              JSON.stringify(b)
            ]);
          }
        }
      }

      // 2. ROOMS
      if (Array.isArray(db.rooms)) {
        let roomCapIsInteger = false;
        try {
          const colCheck = await pgQuery(`SELECT data_type FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'capacity'`);
          if (colCheck.rows.length > 0 && String(colCheck.rows[0].data_type).toLowerCase().includes('int')) {
            await pgQuery(`ALTER TABLE rooms ALTER COLUMN capacity TYPE VARCHAR(100) USING capacity::TEXT`).catch(() => {
              roomCapIsInteger = true;
            });
          }
        } catch (_) {}

        const rIds = db.rooms.map((r: any) => String(r.id || r.roomNumber)).filter(Boolean);
        if (rIds.length > 0) {
          await pgQuery(`DELETE FROM rooms WHERE id NOT IN (${rIds.map((_, i) => `$${i + 1}`).join(', ')})`, rIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM rooms`).catch(() => {});
        }
        for (const r of db.rooms) {
          const id = r.id || r.roomNumber || r.number;
          if (id) {
            const facStr = Array.isArray(r.facilities) ? r.facilities.join(', ') : (r.facilities || '');
            const capNum = Number(r.capacityNumber ?? r.capacity_number) || parseInt(String(r.capacity).replace(/\D/g, '')) || 2;
            const capVal = roomCapIsInteger ? capNum : String(r.capacity || `${capNum} Orang`);

            // Validasi foreign key building_id: harus NULL jika tidak ada gedung yang cocok di database
            let bId: string | null = (r.buildingId || r.building_id || '').trim() || null;
            if (!bId && r.building && Array.isArray(db.buildings)) {
              const foundB = db.buildings.find((b: any) => b.name === r.building || b.id === r.building);
              if (foundB) bId = String(foundB.id || foundB.name).trim() || null;
            }
            if (bId) {
              const chkBld = await pgQuery(`SELECT id FROM buildings WHERE id = $1 LIMIT 1`, [bId]);
              if (chkBld.rows.length === 0) bId = null;
            }

            await pgQuery(`
              INSERT INTO rooms (
                id, room_number, building, building_id, floor, type, bed_type, capacity, capacity_number,
                price_per_night, status, qc_status, facilities, notes, active_tx_id, active_maint_id, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
              ON CONFLICT (id) DO UPDATE SET 
                room_number = EXCLUDED.room_number, 
                building = EXCLUDED.building,
                building_id = EXCLUDED.building_id,
                floor = EXCLUDED.floor,
                type = EXCLUDED.type,
                bed_type = EXCLUDED.bed_type,
                capacity = EXCLUDED.capacity,
                capacity_number = EXCLUDED.capacity_number,
                price_per_night = EXCLUDED.price_per_night,
                status = EXCLUDED.status,
                qc_status = EXCLUDED.qc_status,
                facilities = EXCLUDED.facilities,
                notes = EXCLUDED.notes,
                active_tx_id = EXCLUDED.active_tx_id,
                active_maint_id = EXCLUDED.active_maint_id,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              r.roomNumber || r.number || '',
              r.building || '',
              bId,
              Number(r.floor) || 1,
              r.type || 'Standar',
              r.bedType || r.bed_type || '',
              capVal,
              capNum,
              Number(r.pricePerNight ?? r.price_per_night) || 0,
              r.status || 'KOSONG',
              r.qcStatus || r.qc_status || 'LOLOS_QC',
              facStr,
              r.notes || '',
              r.activeTxId || r.active_tx_id || null,
              r.activeMaintId || r.active_maint_id || null,
              r.updatedAt || r.updated_at || new Date().toISOString(),
              JSON.stringify(r)
            ]);
          }
        }
      }

      // 3. TRANSACTIONS (SELURUH KOLOM OPERASIONAL LENGKAP)
      if (Array.isArray(db.transactions)) {
        const tIds = db.transactions.map((t: any) => String(t.id)).filter(Boolean);
        if (tIds.length > 0) {
          await pgQuery(`DELETE FROM transactions WHERE id NOT IN (${tIds.map((_, i) => `$${i + 1}`).join(', ')})`, tIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM transactions`).catch(() => {});
        }
        for (const t of db.transactions) {
          const id = t.id || t.transactionId;
          if (id) {
            await pgQuery(`
              INSERT INTO transactions (
                id, room_id, room_number, building, guest_name, guest_type, nik_ktp, kloter, phone, email,
                category, status, start_date, duration, duration_unit, price_per_night, total_amount,
                payment_status, payment_method, payment_date, payment_note, kwitansi_no, is_paid, paid_amount,
                dp_amount, remaining_amount, is_group, group_id, group_type, group_name, group_pic, group_pic_phone,
                total_pax, spk_number, check_in_time, check_out_time, notes, created_user, created_at, updated_at,
                extended_count, nomor_porsi, data
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17,
                $18, $19, $20, $21, $22, $23, $24,
                $25, $26, $27, $28, $29, $30, $31, $32,
                $33, $34, $35, $36, $37, $38, $39, $40,
                $41, $42, $43
              )
              ON CONFLICT (id) DO UPDATE SET 
                room_id = EXCLUDED.room_id,
                room_number = EXCLUDED.room_number,
                building = EXCLUDED.building,
                guest_name = EXCLUDED.guest_name,
                guest_type = EXCLUDED.guest_type,
                nik_ktp = EXCLUDED.nik_ktp,
                kloter = EXCLUDED.kloter,
                phone = EXCLUDED.phone,
                email = EXCLUDED.email,
                category = EXCLUDED.category,
                status = EXCLUDED.status,
                start_date = EXCLUDED.start_date,
                duration = EXCLUDED.duration,
                duration_unit = EXCLUDED.duration_unit,
                price_per_night = EXCLUDED.price_per_night,
                total_amount = EXCLUDED.total_amount,
                payment_status = EXCLUDED.payment_status,
                payment_method = EXCLUDED.payment_method,
                payment_date = EXCLUDED.payment_date,
                payment_note = EXCLUDED.payment_note,
                kwitansi_no = EXCLUDED.kwitansi_no,
                is_paid = EXCLUDED.is_paid,
                paid_amount = EXCLUDED.paid_amount,
                dp_amount = EXCLUDED.dp_amount,
                remaining_amount = EXCLUDED.remaining_amount,
                is_group = EXCLUDED.is_group,
                group_id = EXCLUDED.group_id,
                group_type = EXCLUDED.group_type,
                group_name = EXCLUDED.group_name,
                group_pic = EXCLUDED.group_pic,
                group_pic_phone = EXCLUDED.group_pic_phone,
                total_pax = EXCLUDED.total_pax,
                spk_number = EXCLUDED.spk_number,
                check_in_time = EXCLUDED.check_in_time,
                check_out_time = EXCLUDED.check_out_time,
                notes = EXCLUDED.notes,
                created_user = EXCLUDED.created_user,
                created_at = EXCLUDED.created_at,
                updated_at = EXCLUDED.updated_at,
                extended_count = EXCLUDED.extended_count,
                nomor_porsi = EXCLUDED.nomor_porsi,
                data = EXCLUDED.data;
            `, [
              String(id),
              t.roomId || t.room_id || '',
              t.roomNumber || t.room_number || '',
              t.building || '',
              t.guestName || t.namaJemaah || t.guest_name || '',
              t.guestType || t.guest_type || (t.isGroup ? 'ROMBONGAN' : 'INDIVIDU'),
              t.nikKtp || t.nik_ktp || '',
              t.kloter || '',
              t.phone || '',
              t.email || '',
              t.category || 'INDIVIDU',
              t.status || 'TERISI',
              safeDateOrNull(t.startDate || t.start_date),
              Number(t.duration) || 1,
              t.durationUnit || t.duration_unit || 'Malam',
              Number(t.pricePerNight ?? t.price_per_night) || 0,
              Number(t.totalAmount ?? t.total_amount) || 0,
              t.paymentStatus || t.payment_status || 'LUNAS',
              t.paymentMethod || t.payment_method || '',
              safeDateOrNull(t.paymentDate || t.payment_date),
              t.paymentNote || t.payment_note || '',
              t.kwitansiNo || t.kwitansi_no || '',
              Boolean(t.isPaid ?? t.is_paid),
              Number(t.paidAmount ?? t.paid_amount) || 0,
              Number(t.dpAmount ?? t.dp_amount) || 0,
              Number(t.remainingAmount ?? t.remaining_amount) || 0,
              Boolean(t.isGroup ?? t.is_group),
              t.groupId || t.group_id || '',
              t.groupType || t.group_type || '',
              t.groupName || t.group_name || '',
              t.groupPic || t.group_pic || '',
              t.groupPicPhone || t.group_pic_phone || '',
              Number(t.totalPax ?? t.total_pax) || 0,
              t.spkNumber || t.spk_number || '',
              safeDateOrNull(t.checkInTime || t.check_in_time),
              safeDateOrNull(t.checkOutTime || t.check_out_time),
              t.notes || '',
              t.createdUser || t.created_user || 'Petugas',
              safeDateOrNull(t.createdAt || t.created_at) || new Date().toISOString(),
              safeDateOrNull(t.updatedAt || t.updated_at) || new Date().toISOString(),
              Number(t.extendedCount ?? t.extended_count) || 0,
              t.nomorPorsi || t.nomor_porsi || '',
              JSON.stringify(t)
            ]);
          }
        }
      }

      // 4. USERS
      if (Array.isArray(db.users)) {
        const uIds = db.users.map((u: any) => String(u.id || u.username)).filter(Boolean);
        if (uIds.length > 0) {
          await pgQuery(`DELETE FROM users WHERE id NOT IN (${uIds.map((_, i) => `$${i + 1}`).join(', ')})`, uIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM users WHERE username NOT IN ('superadmin', 'admin') AND id NOT IN ('u-superadmin', 'u-admin')`).catch(() => {});
        }
        for (const u of db.users) {
          const id = u.id || u.username;
          if (id) {
            await pgQuery(`
              INSERT INTO users (
                id, username, role, full_name, department, assigned_building, phone, password, signature_url, qr_code_url, nip, email, status, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
              ON CONFLICT (id) DO UPDATE SET 
                username = EXCLUDED.username, 
                role = EXCLUDED.role, 
                full_name = EXCLUDED.full_name,
                department = EXCLUDED.department,
                assigned_building = EXCLUDED.assigned_building,
                phone = EXCLUDED.phone,
                password = EXCLUDED.password,
                signature_url = EXCLUDED.signature_url,
                qr_code_url = EXCLUDED.qr_code_url,
                nip = EXCLUDED.nip,
                email = EXCLUDED.email,
                status = EXCLUDED.status,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              u.username || '',
              u.role || '',
              u.fullName || u.nama || u.full_name || '',
              u.department || 'Operasional',
              u.assignedBuilding || u.assigned_building || 'Semua Gedung',
              u.phone || '-',
              u.password || '12345',
              u.signatureUrl || u.signature_url || '',
              u.qrCodeUrl || u.qr_code_url || '',
              u.nip || '',
              u.email || '',
              u.status || 'Aktif',
              u.updatedAt || u.updated_at || new Date().toISOString(),
              JSON.stringify(u)
            ]);
          }
        }
      }

      // 5. MAINTENANCES
      if (Array.isArray(db.maintenances)) {
        const mIds = db.maintenances.map((m: any) => String(m.id)).filter(Boolean);
        if (mIds.length > 0) {
          await pgQuery(`DELETE FROM maintenances WHERE id NOT IN (${mIds.map((_, i) => `$${i + 1}`).join(', ')})`, mIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM maintenances`).catch(() => {});
        }
        for (const m of db.maintenances) {
          const id = m.id;
          if (id) {
            await pgQuery(`
              INSERT INTO maintenances (
                id, room_id, room_number, building, category, issue, description, urgency, status,
                technician, assigned_technician_id, assigned_technician_name, technician_notes,
                reporter, report_time, resolved_time, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
              ON CONFLICT (id) DO UPDATE SET 
                room_id = EXCLUDED.room_id,
                room_number = EXCLUDED.room_number,
                building = EXCLUDED.building,
                category = EXCLUDED.category,
                issue = EXCLUDED.issue,
                description = EXCLUDED.description,
                urgency = EXCLUDED.urgency,
                status = EXCLUDED.status,
                technician = EXCLUDED.technician,
                assigned_technician_id = EXCLUDED.assigned_technician_id,
                assigned_technician_name = EXCLUDED.assigned_technician_name,
                technician_notes = EXCLUDED.technician_notes,
                reporter = EXCLUDED.reporter,
                report_time = EXCLUDED.report_time,
                resolved_time = EXCLUDED.resolved_time,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              m.roomId || m.room_id || '',
              m.roomNumber || m.room_number || '',
              m.building || '',
              m.category || 'Fasilitas Kamar',
              m.issue || '',
              m.description || m.issue || '',
              m.urgency || 'SEDANG',
              m.status || 'MENUNGGU_PENUGASAN',
              m.technician || 'Belum Ditugaskan',
              m.assignedTechnicianId || m.assigned_technician_id || '',
              m.assignedTechnicianName || m.assigned_technician_name || '',
              m.technicianNotes || m.technician_notes || '',
              m.reporter || 'Resepsionis',
              safeDateOrNull(m.reportTime || m.report_time) || new Date().toISOString(),
              safeDateOrNull(m.resolvedTime || m.resolved_time),
              safeDateOrNull(m.updatedAt || m.updated_at) || new Date().toISOString(),
              JSON.stringify(m)
            ]);
          }
        }
      }

      // 6. QC INSPECTIONS
      if (Array.isArray(db.qcInspections)) {
        const qIds = db.qcInspections.map((q: any) => String(q.id)).filter(Boolean);
        if (qIds.length > 0) {
          await pgQuery(`DELETE FROM qc_inspections WHERE id NOT IN (${qIds.map((_, i) => `$${i + 1}`).join(', ')})`, qIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM qc_inspections`).catch(() => {});
        }
        for (const qc of db.qcInspections) {
          const id = qc.id;
          if (id) {
            await pgQuery(`
              INSERT INTO qc_inspections (
                id, room_number, inspector, building, inspection_date, status, score, notes, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              ON CONFLICT (id) DO UPDATE SET 
                room_number = EXCLUDED.room_number, 
                inspector = EXCLUDED.inspector,
                building = EXCLUDED.building,
                inspection_date = EXCLUDED.inspection_date,
                status = EXCLUDED.status,
                score = EXCLUDED.score,
                notes = EXCLUDED.notes,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              qc.roomNumber || qc.room_number || '',
              qc.inspector || '',
              qc.building || '',
              safeDateOrNull(qc.inspectionDate || qc.inspection_date) || new Date().toISOString(),
              qc.status || 'LOLOS_QC',
              Number(qc.score) || 100,
              qc.notes || '',
              safeDateOrNull(qc.updatedAt || qc.updated_at) || new Date().toISOString(),
              JSON.stringify(qc)
            ]);
          }
        }
      }

      // 7. MEETING ROOMS (AULA / SERBAGUNA)
      if (Array.isArray(db.meetingRooms)) {
        let mrCapIsInteger = false;
        try {
          const colCheck = await pgQuery(`SELECT data_type FROM information_schema.columns WHERE table_name = 'meeting_rooms' AND column_name = 'capacity'`);
          if (colCheck.rows.length > 0 && String(colCheck.rows[0].data_type).toLowerCase().includes('int')) {
            await pgQuery(`ALTER TABLE meeting_rooms ALTER COLUMN capacity TYPE VARCHAR(100) USING capacity::TEXT`).catch(() => {
              mrCapIsInteger = true;
            });
          }
        } catch (_) {}

        const mrIds = db.meetingRooms.map((mr: any) => String(mr.id)).filter(Boolean);
        if (mrIds.length > 0) {
          await pgQuery(`DELETE FROM meeting_rooms WHERE id NOT IN (${mrIds.map((_, i) => `$${i + 1}`).join(', ')})`, mrIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM meeting_rooms`).catch(() => {});
        }
        for (const mr of db.meetingRooms) {
          const id = mr.id;
          if (id) {
            const facStr = Array.isArray(mr.facilities) ? mr.facilities.join(', ') : (mr.facilities || '');
            const capNum = Number(mr.capacityNumber ?? mr.capacity_number) || parseInt(String(mr.capacity).replace(/\D/g, '')) || 100;
            const capVal = mrCapIsInteger ? capNum : String(mr.capacity || `${capNum} Orang`);
            await pgQuery(`
              INSERT INTO meeting_rooms (
                id, name, code, category, building, floor, capacity, capacity_number, daily_rate, session_rate,
                status, qc_status, facilities, description, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
              ON CONFLICT (id) DO UPDATE SET 
                name = EXCLUDED.name,
                code = EXCLUDED.code,
                category = EXCLUDED.category,
                building = EXCLUDED.building,
                floor = EXCLUDED.floor,
                capacity = EXCLUDED.capacity,
                capacity_number = EXCLUDED.capacity_number,
                daily_rate = EXCLUDED.daily_rate,
                session_rate = EXCLUDED.session_rate,
                status = EXCLUDED.status,
                qc_status = EXCLUDED.qc_status,
                facilities = EXCLUDED.facilities,
                description = EXCLUDED.description,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              mr.name || '',
              mr.code || '',
              mr.category || 'AULA',
              mr.building || '',
              Number(mr.floor) || 1,
              capVal,
              capNum,
              Number(mr.dailyRate ?? mr.daily_rate) || 0,
              Number(mr.sessionRate ?? mr.session_rate) || 0,
              mr.status || 'TERSEDIA',
              mr.qcStatus || mr.qc_status || 'LOLOS_QC',
              facStr,
              mr.description || '',
              mr.updatedAt || mr.updated_at || new Date().toISOString(),
              JSON.stringify(mr)
            ]);
          }
        }
      }

      // 8. BREAKFAST ORDERS
      if (Array.isArray(db.breakfastOrders)) {
        const boIds = db.breakfastOrders.map((bo: any) => String(bo.id)).filter(Boolean);
        if (boIds.length > 0) {
          await pgQuery(`DELETE FROM breakfast_orders WHERE id NOT IN (${boIds.map((_, i) => `$${i + 1}`).join(', ')})`, boIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM breakfast_orders`).catch(() => {});
        }
        for (const bo of db.breakfastOrders) {
          const id = bo.id;
          if (id) {
            await pgQuery(`
              INSERT INTO breakfast_orders (
                id, room_number, building, guest_name, phone, transaction_id, menu_name, portions,
                days, start_date, delivery_time, status, price_per_portion, total_price, notes, created_at, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
              ON CONFLICT (id) DO UPDATE SET 
                room_number = EXCLUDED.room_number,
                building = EXCLUDED.building,
                guest_name = EXCLUDED.guest_name,
                phone = EXCLUDED.phone,
                transaction_id = EXCLUDED.transaction_id,
                menu_name = EXCLUDED.menu_name,
                portions = EXCLUDED.portions,
                days = EXCLUDED.days,
                start_date = EXCLUDED.start_date,
                delivery_time = EXCLUDED.delivery_time,
                status = EXCLUDED.status,
                price_per_portion = EXCLUDED.price_per_portion,
                total_price = EXCLUDED.total_price,
                notes = EXCLUDED.notes,
                created_at = EXCLUDED.created_at,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              bo.roomNumber || bo.room_number || '',
              bo.building || '',
              bo.guestName || bo.namaPemesan || bo.guest_name || '',
              bo.phone || '',
              bo.transactionId || bo.transaction_id || '',
              bo.menuName || bo.menu_name || '',
              Number(bo.portions) || 1,
              Number(bo.days) || 1,
              safeDateOrNull(bo.startDate || bo.start_date),
              bo.deliveryTime || bo.delivery_time || '06:30',
              bo.status || 'MENUNGGU',
              Number(bo.pricePerPortion ?? bo.price_per_portion) || 0,
              Number(bo.totalPrice ?? bo.total_price) || 0,
              bo.notes || '',
              safeDateOrNull(bo.createdAt || bo.created_at) || new Date().toISOString(),
              safeDateOrNull(bo.updatedAt || bo.updated_at) || new Date().toISOString(),
              JSON.stringify(bo)
            ]);
          }
        }
      }

      // 9. BREAKFAST MENU ITEMS
      if (Array.isArray(db.breakfastMenuItems)) {
        const bmiIds = db.breakfastMenuItems.map((bmi: any) => String(bmi.id)).filter(Boolean);
        if (bmiIds.length > 0) {
          await pgQuery(`DELETE FROM breakfast_menu_items WHERE id NOT IN (${bmiIds.map((_, i) => `$${i + 1}`).join(', ')})`, bmiIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM breakfast_menu_items`).catch(() => {});
        }
        for (const bmi of db.breakfastMenuItems) {
          const id = bmi.id;
          if (id) {
            await pgQuery(`
              INSERT INTO breakfast_menu_items (
                id, name, category, price, description, is_available, allergens, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              ON CONFLICT (id) DO UPDATE SET 
                name = EXCLUDED.name,
                category = EXCLUDED.category,
                price = EXCLUDED.price,
                description = EXCLUDED.description,
                is_available = EXCLUDED.is_available,
                allergens = EXCLUDED.allergens,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              bmi.name || '',
              bmi.category || 'MAKANAN_BERAT',
              Number(bmi.price) || 0,
              bmi.description || '',
              Boolean(bmi.isAvailable ?? bmi.is_available ?? true),
              bmi.allergens || '',
              bmi.updatedAt || bmi.updated_at || new Date().toISOString(),
              JSON.stringify(bmi)
            ]);
          }
        }
      }

      // 10. ROOM CAPACITY RATES
      if (Array.isArray(db.roomCapacityRates)) {
        const rcrIds = db.roomCapacityRates.map((rcr: any) => String(rcr.id)).filter(Boolean);
        if (rcrIds.length > 0) {
          await pgQuery(`DELETE FROM room_capacity_rates WHERE id NOT IN (${rcrIds.map((_, i) => `$${i + 1}`).join(', ')})`, rcrIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM room_capacity_rates`).catch(() => {});
        }
        for (const rcr of db.roomCapacityRates) {
          const id = rcr.id;
          if (id) {
            const facStr = Array.isArray(rcr.facilities) ? rcr.facilities.join(', ') : (rcr.facilities || '');
            await pgQuery(`
              INSERT INTO room_capacity_rates (
                id, room_type, bed_type, capacity_pax, price_per_night, description, facilities, is_active, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              ON CONFLICT (id) DO UPDATE SET 
                room_type = EXCLUDED.room_type,
                bed_type = EXCLUDED.bed_type,
                capacity_pax = EXCLUDED.capacity_pax,
                price_per_night = EXCLUDED.price_per_night,
                description = EXCLUDED.description,
                facilities = EXCLUDED.facilities,
                is_active = EXCLUDED.is_active,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              rcr.roomType || rcr.room_type || '',
              rcr.bedType || rcr.bed_type || '',
              Number(rcr.capacityPax ?? rcr.capacity_pax) || 2,
              Number(rcr.pricePerNight ?? rcr.price_per_night) || 0,
              rcr.description || '',
              facStr,
              Boolean(rcr.isActive ?? rcr.is_active ?? true),
              rcr.updatedAt || rcr.updated_at || new Date().toISOString(),
              JSON.stringify(rcr)
            ]);
          }
        }
      }

      // 11. WORK SESSIONS
      if (Array.isArray(db.workSessions)) {
        const wsIds = db.workSessions.map((ws: any) => String(ws.id)).filter(Boolean);
        if (wsIds.length > 0) {
          await pgQuery(`DELETE FROM work_sessions WHERE id NOT IN (${wsIds.map((_, i) => `$${i + 1}`).join(', ')})`, wsIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM work_sessions`).catch(() => {});
        }
        for (const ws of db.workSessions) {
          const id = ws.id;
          if (id) {
            await pgQuery(`
              INSERT INTO work_sessions (id, user_id, user_name, data) VALUES ($1, $2, $3, $4)
              ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name, data = EXCLUDED.data;
            `, [String(id), ws.userId || ws.user_id || '', ws.userName || ws.user_name || '', JSON.stringify(ws)]);
          }
        }
      }

      // 12. AUDIT LOGS
      if (Array.isArray(db.auditLogs)) {
        const alIds = db.auditLogs.map((al: any) => String(al.id)).filter(Boolean);
        if (alIds.length > 0) {
          await pgQuery(`DELETE FROM audit_logs WHERE id NOT IN (${alIds.map((_, i) => `$${i + 1}`).join(', ')})`, alIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM audit_logs`).catch(() => {});
        }
        for (const al of db.auditLogs.slice(0, 150)) {
          const id = al.id;
          if (id) {
            await pgQuery(`
              INSERT INTO audit_logs (id, action, data) VALUES ($1, $2, $3)
              ON CONFLICT (id) DO UPDATE SET action = EXCLUDED.action, data = EXCLUDED.data;
            `, [String(id), al.action || '', JSON.stringify(al)]);
          }
        }
      }

      // 13. CLEANING LOGS
      if (Array.isArray(db.cleaningLogs)) {
        const clIds = db.cleaningLogs.map((cl: any) => String(cl.id)).filter(Boolean);
        if (clIds.length > 0) {
          await pgQuery(`DELETE FROM cleaning_logs WHERE id NOT IN (${clIds.map((_, i) => `$${i + 1}`).join(', ')})`, clIds).catch(() => {});
        } else {
          await pgQuery(`DELETE FROM cleaning_logs`).catch(() => {});
        }
        for (const cl of db.cleaningLogs) {
          const id = cl.id;
          if (id) {
            await pgQuery(`
              INSERT INTO cleaning_logs (
                id, room_number, building, petugas_id, petugas_name, timestamp, status, notes, photo_url, updated_at, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              ON CONFLICT (id) DO UPDATE SET 
                room_number = EXCLUDED.room_number,
                building = EXCLUDED.building,
                petugas_id = EXCLUDED.petugas_id,
                petugas_name = EXCLUDED.petugas_name,
                timestamp = EXCLUDED.timestamp,
                status = EXCLUDED.status,
                notes = EXCLUDED.notes,
                photo_url = EXCLUDED.photo_url,
                updated_at = EXCLUDED.updated_at,
                data = EXCLUDED.data;
            `, [
              String(id),
              cl.roomNumber || cl.room_number || '',
              cl.building || '',
              cl.petugasId || cl.petugas_id || '',
              cl.petugasName || cl.petugas_name || '',
              safeDateOrNull(cl.timestamp) || new Date().toISOString(),
              cl.status || 'MENUNGGU_QC',
              cl.notes || '',
              cl.photoUrl || cl.photo_url || '',
              safeDateOrNull(cl.updatedAt || cl.updated_at) || new Date().toISOString(),
              JSON.stringify(cl)
            ]);
          }
        }
      }

    } catch (err: any) {
      console.error("Error populating relational tables:", err);
      throw err;
    }
  }

  async function ensureAppKvTable() {
    await ensureAndPopulateRelationalTables({});
  }

  app.post("/api/pg/configure", async (req, res) => {
    const { databaseUrl } = req.body || {};
    if (!databaseUrl || typeof databaseUrl !== 'string') {
      return res.status(400).json({ success: false, error: "Database URL tidak valid" });
    }
    try {
      updatePoolConfig(databaseUrl.trim());
      try {
        fs.writeFileSync(aivenConfigFilePath, JSON.stringify({ databaseUrl: databaseUrl.trim(), updatedAt: new Date().toISOString() }, null, 2), "utf-8");
      } catch (_) {}
      await ensureAppKvTable();
      const { rows } = await pgQuery("SELECT NOW() as now");
      res.json({ success: true, message: "Koneksi Aiven PostgreSQL berhasil dikonfigurasi!", time: rows[0]?.now });
    } catch (err: any) {
      console.error("Configure Aiven error:", err);
      res.status(500).json({ success: false, error: err?.message || "Gagal menghubungkan database dengan URL tersebut" });
    }
  });

  app.get("/api/pg/test", async (_req, res) => {
    if (!process.env.DATABASE_URL) {
      return res.status(400).json({ success: false, error: "DATABASE_URL belum dikonfigurasi." });
    }
    try {
      await ensureAppKvTable();
      const { rows } = await pgQuery("SELECT NOW() as now");
      res.json({ success: true, message: "Koneksi ke Aiven PostgreSQL berhasil!", time: rows[0]?.now });
    } catch (err: any) {
      console.error("Test Aiven error:", err);
      res.status(500).json({ success: false, error: err?.message || "Koneksi database gagal" });
    }
  });

  app.get("/api/pg/database", async (_req, res) => {
    if (!process.env.DATABASE_URL) {
      return res.json({ success: false, notConfigured: true, error: "DATABASE_URL belum dikonfigurasi" });
    }
    try {
      await ensureAppKvTable();
      const { rows } = await pgQuery("SELECT value FROM app_kv WHERE key = 'full_database'");
      if (rows.length > 0 && rows[0].value) {
        res.json({ success: true, data: JSON.parse(rows[0].value) });
      } else {
        const bRes = await pgQuery("SELECT data FROM buildings").catch(() => ({ rows: [] }));
        const rRes = await pgQuery("SELECT data FROM rooms").catch(() => ({ rows: [] }));
        const tRes = await pgQuery("SELECT data FROM transactions").catch(() => ({ rows: [] }));
        const uRes = await pgQuery("SELECT data FROM users").catch(() => ({ rows: [] }));
        const mRes = await pgQuery("SELECT data FROM maintenances").catch(() => ({ rows: [] }));
        const qRes = await pgQuery("SELECT data FROM qc_inspections").catch(() => ({ rows: [] }));
        const wRes = await pgQuery("SELECT data FROM work_sessions").catch(() => ({ rows: [] }));
        const mrRes = await pgQuery("SELECT data FROM meeting_rooms").catch(() => ({ rows: [] }));
        const boRes = await pgQuery("SELECT data FROM breakfast_orders").catch(() => ({ rows: [] }));
        const bmiRes = await pgQuery("SELECT data FROM breakfast_menu_items").catch(() => ({ rows: [] }));
        const alRes = await pgQuery("SELECT data FROM audit_logs").catch(() => ({ rows: [] }));
        const clRes = await pgQuery("SELECT data FROM cleaning_logs").catch(() => ({ rows: [] }));

        const reconstructed = {
          buildings: bRes.rows.map(r => r.data).filter(Boolean),
          rooms: rRes.rows.map(r => r.data).filter(Boolean),
          transactions: tRes.rows.map(r => r.data).filter(Boolean),
          users: uRes.rows.map(r => r.data).filter(Boolean),
          maintenances: mRes.rows.map(r => r.data).filter(Boolean),
          qcInspections: qRes.rows.map(r => r.data).filter(Boolean),
          workSessions: wRes.rows.map(r => r.data).filter(Boolean),
          meetingRooms: mrRes.rows.map(r => r.data).filter(Boolean),
          breakfastOrders: boRes.rows.map(r => r.data).filter(Boolean),
          breakfastMenuItems: bmiRes.rows.map(r => r.data).filter(Boolean),
          auditLogs: alRes.rows.map(r => r.data).filter(Boolean),
          cleaningLogs: clRes.rows.map(r => r.data).filter(Boolean),
        };

        if (reconstructed.buildings.length > 0 || reconstructed.rooms.length > 0 || reconstructed.transactions.length > 0) {
          res.json({ success: true, data: reconstructed });
        } else {
          res.json({ success: true, data: null });
        }
      }
    } catch (err: any) {
      console.warn("Get database from Aiven warning:", err?.message);
      res.status(500).json({ success: false, error: err?.message });
    }
  });

  app.post("/api/pg/database", async (req, res) => {
    if (!process.env.DATABASE_URL) {
      return res.json({ success: false, notConfigured: true, error: "DATABASE_URL belum dikonfigurasi" });
    }
    try {
      const dbData = req.body;
      await ensureAndPopulateRelationalTables(dbData);
      res.json({ success: true, message: "Seluruh data berhasil disimpan ke tabel relasional Aiven PostgreSQL" });
    } catch (err: any) {
      console.error("Save database to Aiven error:", err);
      res.status(500).json({ success: false, error: err?.message || "Gagal menyimpan ke Aiven PostgreSQL" });
    }
  });

  app.delete("/api/pg/:table/:id", async (req, res) => {
    const { table, id } = req.params;
    const sanitizedTable = table.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    if (!sanitizedTable) {
      return res.status(400).json({ success: false, error: "Invalid table name" });
    }
    try {
      await pgQuery(`DELETE FROM ${sanitizedTable} WHERE id = $1 OR code = $1`, [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message });
    }
  });

  app.get("/api/pg/:table", async (req, res) => {
    const { table } = req.params;
    const sanitizedTable = table.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    if (!sanitizedTable) {
      return res.status(400).json({ success: false, error: "Invalid table name" });
    }
    try {
      const { rows } = await pgQuery(`SELECT * FROM ${sanitizedTable} LIMIT 200`);
      res.json({ success: true, data: rows });
    } catch (error: any) {
      console.warn(`[PostgreSQL] Query failed for table ${sanitizedTable}:`, error?.message);
      res.status(500).json({ success: false, error: error?.message || "Database error", data: [] });
    }
  });

  app.post("/api/pg/:table", async (req, res) => {
    const { table } = req.params;
    const sanitizedTable = table.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    if (!sanitizedTable) {
      return res.status(400).json({ success: false, error: "Invalid table name" });
    }
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: "Body must be an object" });
    }

    // Normalisasi properti camelCase ke snake_case
    const rowData: Record<string, any> = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'data') continue;
      const snakeKey = k.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).toLowerCase();
      if (/^[a-z0-9_]+$/.test(snakeKey)) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          rowData[snakeKey] = JSON.stringify(v);
        } else if (Array.isArray(v)) {
          rowData[snakeKey] = v.length > 0 && typeof v[0] === 'object' ? JSON.stringify(v) : v.join(', ');
        } else {
          rowData[snakeKey] = v;
        }
      }
    }

    // Selalu pastikan kolom 'data' terisi dengan representasi JSON lengkap
    rowData['data'] = JSON.stringify(body);

    const keys = Object.keys(rowData);
    if (keys.length === 0) {
      return res.status(400).json({ success: false, error: "No valid columns provided" });
    }

    try {
      // Ambil daftar kolom dan tipe datanya yang benar-benar ada di tabel database saat ini
      const colQuery = await pgQuery(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
        [sanitizedTable]
      );
      const colTypeMap = new Map<string, string>(colQuery.rows.map((r: any) => [r.column_name.toLowerCase(), String(r.data_type || '').toLowerCase()]));
      const validDbCols = new Set(colTypeMap.keys());

      // Saring hanya kolom yang ada di skema tabel database
      let filteredKeys = keys.filter(k => validDbCols.has(k.toLowerCase()));
      if (filteredKeys.length === 0 || !validDbCols.has('id')) {
        filteredKeys = keys.filter(k => k === 'id' || k === 'data');
      }

      const uniqueCols = Array.from(new Set(filteredKeys));
      const values = uniqueCols.map(k => {
        const val = rowData[k];
        const dt = colTypeMap.get(k.toLowerCase()) || '';
        // Jika kolom bertipe waktu/tanggal/angka dan nilai berupa string kosong atau undefined, kirimkan null
        if (val === '' || val === undefined) {
          if (dt.includes('timestamp') || dt.includes('date') || dt.includes('int') || dt.includes('numeric') || dt.includes('float') || dt.includes('double')) {
            return null;
          }
        }
        return val;
      });
      const placeholders = uniqueCols.map((_, idx) => `$${idx + 1}`).join(", ");
      const columns = uniqueCols.join(", ");

      const updateAssignments = uniqueCols
        .filter(k => k !== 'id')
        .map(k => `${k} = EXCLUDED.${k}`)
        .join(", ");

      const sql = uniqueCols.includes('id') && updateAssignments
        ? `INSERT INTO ${sanitizedTable} (${columns}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updateAssignments} RETURNING *;`
        : `INSERT INTO ${sanitizedTable} (${columns}) VALUES (${placeholders}) RETURNING *;`;

      const { rows } = await pgQuery(sql, values);
      res.json({ success: true, data: rows[0] });
    } catch (error: any) {
      console.error(`[PostgreSQL] Insert failed for table ${sanitizedTable}:`, error?.message);
      res.status(500).json({ success: false, error: error?.message || "Database insert error" });
    }
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