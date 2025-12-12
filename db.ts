import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  incidents,
  incidentParties,
  services,
  incidentMedia,
  incidentHistory,
  statistics,
  reportSends,
} from "../drizzle/schema";
import { ENV } from './_core/env';

import type { Incident, IncidentParty, Service, IncidentMedia as IIncidentMedia, IncidentHistory, Statistic, ReportSend } from "../drizzle/schema";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ===== Incident Queries =====
export async function createIncident(data: {
  reporterId: number;
  incidentType: "injury" | "breakdown" | "traffic";
  location: string;
  latitude: string;
  longitude: string;
  description?: string;
  severity?: "low" | "medium" | "high" | "critical";
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(incidents).values({
    reporterId: data.reporterId,
    incidentType: data.incidentType,
    location: data.location,
    latitude: data.latitude as any,
    longitude: data.longitude as any,
    description: data.description,
    severity: data.severity || "medium",
    status: "pending",
  });

  return { insertId: result[0]?.insertId || 0 };
}

export async function getIncidentById(incidentId: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

export async function getAllIncidents(limit = 50, offset = 0) {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(incidents).limit(limit).offset(offset);
}

export async function updateIncidentStatus(
  incidentId: number,
  status: "pending" | "assigned" | "in_progress" | "resolved" | "closed"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .update(incidents)
    .set({ status, updatedAt: new Date() })
    .where(eq(incidents.id, incidentId));
}

// ===== Incident Parties Queries =====
export async function addIncidentParty(data: {
  incidentId: number;
  partyName: string;
  phone?: string;
  vehicleNumber?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(incidentParties).values(data);
  return { insertId: result[0]?.insertId || 0 };
}

export async function getIncidentParties(incidentId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(incidentParties)
    .where(eq(incidentParties.incidentId, incidentId));
}

export async function updatePartyFaultPercentage(
  partyId: number,
  faultPercentage: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .update(incidentParties)
    .set({ faultPercentage })
    .where(eq(incidentParties.id, partyId));
}

// ===== Services Queries =====
export async function createService(data: {
  incidentId: number;
  serviceType: "ambulance" | "tow_truck" | "traffic_control" | "police" | "fire";
  assignedTo?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(services).values({
    incidentId: data.incidentId,
    serviceType: data.serviceType,
    status: "pending",
    assignedTo: data.assignedTo,
  });
  return { insertId: result[0]?.insertId || 0 };
}

export async function getIncidentServices(incidentId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(services)
    .where(eq(services.incidentId, incidentId));
}

export async function updateServiceStatus(
  serviceId: number,
  status: "pending" | "assigned" | "en_route" | "arrived" | "completed" | "cancelled"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .update(services)
    .set({ status, updatedAt: new Date() })
    .where(eq(services.id, serviceId));
}

// ===== Incident Media Queries =====
export async function addIncidentMedia(data: {
  incidentId: number;
  mediaType: "image" | "video";
  mediaUrl: string;
  description?: string;
  isSimulated?: boolean;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(incidentMedia).values({
    incidentId: data.incidentId,
    mediaType: data.mediaType,
    mediaUrl: data.mediaUrl,
    description: data.description,
    isSimulated: data.isSimulated ?? true,
  });
  return { insertId: result[0]?.insertId || 0 };
}

export async function getIncidentMedia(incidentId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(incidentMedia)
    .where(eq(incidentMedia.incidentId, incidentId));
}

// ===== Incident History Queries =====
export async function addIncidentHistory(data: {
  incidentId: number;
  action: string;
  details?: string;
  performedBy?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(incidentHistory).values(data);
}

export async function getIncidentHistory(incidentId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(incidentHistory)
    .where(eq(incidentHistory.incidentId, incidentId))
    .orderBy((t) => t.createdAt);
}

// ===== Statistics Queries =====
export async function getTodayStatistics() {
  const db = await getDb();
  if (!db) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await db
    .select()
    .from(statistics)
    .where((t) => eq(t.date, today))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

export async function updateStatistics() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const incidentsData = await db
    .select()
    .from(incidents)
    .where((t) => eq(t.incidentType, "injury"));

  return await db.insert(statistics).values({
    date: today,
    totalIncidents: 0,
    injuryIncidents: 0,
    breakdownIncidents: 0,
    trafficIncidents: 0,
    averageResolutionTime: 0,
  });
}


// ===== Report Sends Queries =====
export async function createReportSend(data: {
  incidentId: number;
  recipientType: "party" | "insurance" | "najm" | "operator";
  recipientEmail: string;
  recipientPhone?: string;
  recipientName?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(reportSends).values({
    incidentId: data.incidentId,
    recipientType: data.recipientType,
    recipientEmail: data.recipientEmail,
    recipientPhone: data.recipientPhone,
    recipientName: data.recipientName,
    status: "pending",
  });
  return { insertId: result[0]?.insertId || 0 };
}

export async function getReportSends(incidentId: number) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(reportSends)
    .where(eq(reportSends.incidentId, incidentId));
}

export async function updateReportSendStatus(
  reportSendId: number,
  status: "pending" | "sent" | "failed" | "read",
  failureReason?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const updateData: any = {
    status,
    updatedAt: new Date(),
  };

  if (status === "sent") {
    updateData.sentAt = new Date();
  } else if (status === "read") {
    updateData.readAt = new Date();
  } else if (status === "failed" && failureReason) {
    updateData.failureReason = failureReason;
  }

  return await db
    .update(reportSends)
    .set(updateData)
    .where(eq(reportSends.id, reportSendId));
}
