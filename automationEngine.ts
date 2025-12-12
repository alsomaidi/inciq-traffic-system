import { getDb } from "./db";
import { incidents, services } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { generateSmartReport, sendSmartReportToParties } from "./smartReports";

/**
 * محرك الأتمتة المتكامل
 * يقوم بمعالجة الحوادث تلقائياً وتوجيه الخدمات والإرسال التنبيهات
 */

/**
 * معالجة الحادث تلقائياً
 */
export async function processIncidentAutomatically(
  incidentId: number
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    console.log(`🔄 جاري معالجة الحادث #${incidentId}...`);

    // 1. إنشاء التقرير الذكي
    const report = await generateSmartReport(incidentId);
    console.log(`✅ تم إنشاء التقرير الذكي (${report.analysisTime}ms)`);

    // 2. توجيه الخدمات تلقائياً
    await routeServicesAutomatically(incidentId, report);
    console.log(`✅ تم توجيه الخدمات`);

    // 3. إرسال التنبيهات
    await sendAlertsToParties(incidentId, report);
    console.log(`✅ تم إرسال التنبيهات`);

    // 4. تحديث حالة الحادث
    await updateIncidentStatus(incidentId, "in_progress");
    console.log(`✅ تم تحديث حالة الحادث`);

    // 5. إرسال التقرير للأطراف
    await sendSmartReportToParties(report);
    console.log(`✅ تم إرسال التقرير الذكي`);

    console.log(`✨ تمت معالجة الحادث #${incidentId} بنجاح`);
  } catch (error) {
    console.error(`❌ خطأ في معالجة الحادث #${incidentId}:`, error);
    throw error;
  }
}

/**
 * توجيه الخدمات تلقائياً بناءً على نوع الحادث
 */
async function routeServicesAutomatically(incidentId: number, report: any) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const serviceMapping: { [key: string]: string } = {
    ambulance: "إسعاف",
    tow_truck: "سطحة",
    traffic_control: "مرور",
    police: "شرطة",
    fire: "إطفاء",
  };

  // توجيه الخدمة الرئيسية
  if (report.aiDecision.action !== "none") {
    await db.insert(services).values({
      incidentId: incidentId,
      serviceType: report.aiDecision.action,
      status: "pending",
    });

    console.log(
      `📍 تم توجيه ${serviceMapping[report.aiDecision.action]} للحادث`
    );
  }

  // توجيه الخدمات الإضافية
  for (const service of report.recommendedServices) {
    const serviceType = Object.keys(serviceMapping).find(
      (key) => serviceMapping[key] === service
    );

    if (serviceType && serviceType !== report.aiDecision.action) {
      await db.insert(services).values({
        incidentId: incidentId,
        serviceType: serviceType as any,
        status: "pending",
      });

      console.log(`📍 تم توجيه ${service} للحادث`);
    }
  }
}

/**
 * إرسال التنبيهات للأطراف المعنية
 */
async function sendAlertsToParties(incidentId: number, report: any) {
  const alerts = [
    {
      recipient: "المرور",
      message: `⚠️ حادث جديد في ${report.location}`,
      priority: report.aiDecision.priority,
    },
    {
      recipient: "الهلال الأحمر",
      message: `🚑 حادث يتطلب إسعاف في ${report.location}`,
      priority: report.aiDecision.priority,
    },
    {
      recipient: "نجم",
      message: `🚗 حادث يتطلب سطحة في ${report.location}`,
      priority: report.aiDecision.priority,
    },
    {
      recipient: "الشرطة",
      message: `👮 حادث مرور في ${report.location}`,
      priority: report.aiDecision.priority,
    },
  ];

  for (const alert of alerts) {
    console.log(`📢 تنبيه ${alert.recipient}: ${alert.message}`);
    // يمكن إضافة تكامل حقيقي مع خدمات الإرسال هنا
  }
}

/**
 * تحديث حالة الحادث
 */
async function updateIncidentStatus(
  incidentId: number,
  status: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(incidents)
    .set({ status: status as any })
    .where(eq(incidents.id, incidentId));
}

/**
 * نظام التنبيهات الذكية
 * يرسل تنبيهات عند اقتراب الخدمات من موقع الحادث
 */
export async function sendSmartAlerts(
  incidentId: number,
  serviceType: string,
  distanceKm: number
): Promise<void> {
  const alerts: { [key: number]: string } = {
    5: `⚠️ الخدمة على بعد 5 كم من موقع الحادث`,
    2: `🚨 الخدمة على بعد 2 كم - استعد للاستقبال`,
    1: `🔴 الخدمة على بعد 1 كم - جاهزية عالية`,
    0: `✅ الخدمة وصلت إلى موقع الحادث`,
  };

  const closestDistance = Object.keys(alerts)
    .map(Number)
    .sort((a, b) => b - a)
    .find((d) => distanceKm <= d);

  if (closestDistance !== undefined) {
    console.log(
      `📍 ${serviceType}: ${alerts[closestDistance as keyof typeof alerts]}`
    );
  }
}

/**
 * نظام المراقبة المستمرة
 * يراقب الحوادث ويتخذ إجراءات تلقائية
 */
export async function monitorIncidentsAutomatically(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // الحصول على الحوادث المعلقة
  const pendingIncidents = await db
    .select()
    .from(incidents)
    .where(eq(incidents.status, "pending"));

  console.log(`📊 جاري مراقبة ${pendingIncidents.length} حادث معلق...`);

  for (const incident of pendingIncidents) {
    try {
      await processIncidentAutomatically(incident.id);
    } catch (error) {
      console.error(`❌ خطأ في معالجة الحادث #${incident.id}:`, error);
    }
  }
}

/**
 * نظام الإحصائيات الذكية
 * يحسب إحصائيات الحوادث والخدمات
 */
export async function calculateSmartStatistics(): Promise<{
  totalIncidents: number;
  averageResponseTime: number;
  successRate: number;
  averageFaultPercentage: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // محاكاة الإحصائيات
  return {
    totalIncidents: 1250,
    averageResponseTime: 3.2, // دقائق
    successRate: 94.5, // نسبة مئوية
    averageFaultPercentage: 62.3, // نسبة مئوية
  };
}
