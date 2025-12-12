import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure } from "./_core/trpc";
import { z } from "zod";
import {
  createIncident,
  getIncidentById,
  getAllIncidents,
  updateIncidentStatus,
  addIncidentParty,
  getIncidentParties,
  updatePartyFaultPercentage,
  createService,
  getIncidentServices,
  updateServiceStatus,
  addIncidentMedia,
  getIncidentMedia,
  addIncidentHistory,
  getIncidentHistory,
  getTodayStatistics,
} from "./db";
import { eq } from "drizzle-orm";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // ===== Incident Management Procedures =====
  incidents: router({
    // إنشاء بلاغ حادث جديد
    create: protectedProcedure
      .input(
        z.object({
          incidentType: z.enum(["injury", "breakdown", "traffic"]),
          location: z.string().min(1),
          latitude: z.string(),
          longitude: z.string(),
          description: z.string().optional(),
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const result = await createIncident({
          reporterId: ctx.user.id,
          incidentType: input.incidentType,
          location: input.location,
          latitude: input.latitude,
          longitude: input.longitude,
          description: input.description,
          severity: input.severity,
        });

        // تسجيل الحادث في السجل التاريخي
        await addIncidentHistory({
          incidentId: result.insertId as number,
          action: "Incident created",
          details: `Incident of type ${input.incidentType} reported at ${input.location}`,
          performedBy: ctx.user.id,
        });

        return { id: result.insertId };
      }),

     // الحصول على بيانات الحادث
    getById: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return await getIncidentById(input.id);
      }),

    // تحليل الصور باستخدام AI
    analyzeImages: protectedProcedure
      .input(
        z.object({
          images: z.array(z.string()),
          incidentType: z.enum(["injury", "breakdown", "traffic"]),
        })
      )
      .mutation(async ({ input }) => {
        try {
          const { invokeLLM } = await import("./_core/llm");

          // بناء رسالة للنموذج
          const imageContents = input.images.map((image) => ({
            type: "image_url" as const,
            image_url: {
              url: image,
              detail: "high" as const,
            },
          }));

          const response = await invokeLLM({
            messages: [
              {
                role: "system",
                content: `أنت متخصص في تحليل حوادث المرور. قم بتحليل الصور واستخراج البيانات المهمة بصيغة JSON.`,
              },
              {
                role: "user",
                content: [
                  ...imageContents,
                  {
                    type: "text",
                    text: `النوع المبلغ عنه: ${input.incidentType}

استخرج البيانات التالية بصيغة JSON:
{
  "description": "وصف مفصل للحادث",
  "damageLevel": "نسبة الضرر من 0-100",
  "affectedParts": ["الأجزاء المتضررة"],
  "severity": "مستوى الخطورة: low/medium/high/critical",
  "estimatedCost": "التكلفة المقدرة بالريال",
  "recommendations": ["التوصيات"]
}`,
                  },
                ],
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "incident_analysis",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    damageLevel: { type: "number" },
                    affectedParts: { type: "array", items: { type: "string" } },
                    severity: { type: "string" },
                    estimatedCost: { type: "number" },
                    recommendations: { type: "array", items: { type: "string" } },
                  },
                  required: [
                    "description",
                    "damageLevel",
                    "affectedParts",
                    "severity",
                    "estimatedCost",
                    "recommendations",
                  ],
                  additionalProperties: false,
                },
              },
            },
          });

          // استخراج البيانات
          const content = response.choices[0]?.message?.content;
          const extractedData = typeof content === 'string' ? JSON.parse(content) : null;

          return {
            success: true,
            extractedData,
          };
        } catch (error) {
          console.error("Error analyzing images:", error);
          return {
            success: false,
            extractedData: null,
          };
        }
      }),

    // الحصول على بيانات الحادث الكاملة مع التفاصيل (الخدمات، الأطراف، الصور)
    getFullDetails: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const incident = await getIncidentById(input.id);
        if (!incident) return null;

        const services = await getIncidentServices(input.id);
        const parties = await getIncidentParties(input.id);
        const media = await getIncidentMedia(input.id);

        return {
          incident,
          services,
          parties,
          media,
        };
      }),

    // الحصول على جميع الحوادث
    list: publicProcedure
      .input(
        z.object({
          limit: z.number().default(50),
          offset: z.number().default(0),
        })
      )
      .query(async ({ input }) => {
        return await getAllIncidents(input.limit, input.offset);
      }),

    // تحديث حالة الحادث
    updateStatus: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          status: z.enum(["pending", "assigned", "in_progress", "resolved", "closed"]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // التحقق من الصلاحيات (يجب أن يكون operator أو admin)
        if (ctx.user.role === "user") {
          throw new Error("Unauthorized: Only operators and admins can update incident status");
        }

        await updateIncidentStatus(input.id, input.status);

        // تسجيل الإجراء في السجل التاريخي
        await addIncidentHistory({
          incidentId: input.id,
          action: "Status updated",
          details: `Status changed to ${input.status}`,
          performedBy: ctx.user.id,
        });

        return { success: true };
      }),
  }),

  // ===== Incident Parties Management =====
  parties: router({
    // إضافة طرف متورط في الحادث
    add: protectedProcedure
      .input(
        z.object({
          incidentId: z.number(),
          partyName: z.string().min(1),
          phone: z.string().optional(),
          vehicleNumber: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role === "user") {
          throw new Error("Unauthorized");
        }

        const result = await addIncidentParty({
          incidentId: input.incidentId,
          partyName: input.partyName,
          phone: input.phone,
          vehicleNumber: input.vehicleNumber,
        });

        await addIncidentHistory({
          incidentId: input.incidentId,
          action: "Party added",
          details: `Party ${input.partyName} added to incident`,
          performedBy: ctx.user.id,
        });

        return { id: result.insertId };
      }),

    // الحصول على الأطراف المتورطة في حادث
    getByIncident: publicProcedure
      .input(z.object({ incidentId: z.number() }))
      .query(async ({ input }) => {
        return await getIncidentParties(input.incidentId);
      }),

    // تحديث نسبة الخطأ
    updateFaultPercentage: protectedProcedure
      .input(
        z.object({
          partyId: z.number(),
          incidentId: z.number(),
          faultPercentage: z.number().min(0).max(100),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role === "user") {
          throw new Error("Unauthorized");
        }

        await updatePartyFaultPercentage(input.partyId, input.faultPercentage);

        await addIncidentHistory({
          incidentId: input.incidentId,
          action: "Fault percentage updated",
          details: `Fault percentage set to ${input.faultPercentage}%`,
          performedBy: ctx.user.id,
        });

        return { success: true };
      }),
  }),

  // ===== Services Management =====
  services: router({
    // إنشاء طلب خدمة
    create: protectedProcedure
      .input(
        z.object({
          incidentId: z.number(),
          serviceType: z.enum(["ambulance", "tow_truck", "traffic_control", "police", "fire"]),
          assignedTo: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role === "user") {
          throw new Error("Unauthorized");
        }

        const result = await createService({
          incidentId: input.incidentId,
          serviceType: input.serviceType,
          assignedTo: input.assignedTo,
        });

        await addIncidentHistory({
          incidentId: input.incidentId,
          action: "Service requested",
          details: `${input.serviceType} service requested`,
          performedBy: ctx.user.id,
        });

        return { id: result.insertId };
      }),

    // الحصول على الخدمات المطلوبة لحادث
    getByIncident: publicProcedure
      .input(z.object({ incidentId: z.number() }))
      .query(async ({ input }) => {
        return await getIncidentServices(input.incidentId);
      }),

    // تحديث حالة الخدمة
    updateStatus: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          incidentId: z.number(),
          status: z.enum(["pending", "assigned", "en_route", "arrived", "completed", "cancelled"]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role === "user") {
          throw new Error("Unauthorized");
        }

        await updateServiceStatus(input.id, input.status);

        await addIncidentHistory({
          incidentId: input.incidentId,
          action: "Service status updated",
          details: `Service status changed to ${input.status}`,
          performedBy: ctx.user.id,
        });

        return { success: true };
      }),
  }),

  // ===== Incident Media Management =====
  media: router({
    // إضافة صورة أو فيديو محاكاة
    add: protectedProcedure
      .input(
        z.object({
          incidentId: z.number(),
          mediaType: z.enum(["image", "video"]),
          mediaUrl: z.string().url(),
          description: z.string().optional(),
          isSimulated: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role === "user") {
          throw new Error("Unauthorized");
        }

        const result = await addIncidentMedia({
          incidentId: input.incidentId,
          mediaType: input.mediaType,
          mediaUrl: input.mediaUrl,
          description: input.description,
          isSimulated: input.isSimulated,
        });

        await addIncidentHistory({
          incidentId: input.incidentId,
          action: "Media added",
          details: `${input.mediaType} media added to incident`,
          performedBy: ctx.user.id,
        });

        return { id: result.insertId };
      }),

    // الحصول على الوسائط لحادث
    getByIncident: publicProcedure
      .input(z.object({ incidentId: z.number() }))
      .query(async ({ input }) => {
        return await getIncidentMedia(input.incidentId);
      }),
  }),

  // ===== Incident History =====
  history: router({
    // الحصول على السجل التاريخي لحادث
    getByIncident: publicProcedure
      .input(z.object({ incidentId: z.number() }))
      .query(async ({ input }) => {
        return await getIncidentHistory(input.incidentId);
      }),
  }),

  // ===== Statistics =====
  stats: router({
    // الحصول على إحصائيات اليوم
    today: publicProcedure.query(async () => {
      return await getTodayStatistics();
    }),
  }),

  // ===== Report Sends =====
  reports: router({
    // إرسال التقرير إلى الطرفين والتأمين
    send: protectedProcedure
      .input(
        z.object({
          incidentId: z.number(),
          recipients: z.array(
            z.object({
              type: z.enum(["party", "insurance", "najm", "operator"]),
              email: z.string().email(),
              phone: z.string().optional(),
              name: z.string().optional(),
            })
          ),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { createReportSend } = await import("./db");
        
        const results = [];
        for (const recipient of input.recipients) {
          const result = await createReportSend({
            incidentId: input.incidentId,
            recipientType: recipient.type,
            recipientEmail: recipient.email,
            recipientPhone: recipient.phone,
            recipientName: recipient.name,
          });
          results.push(result);
        }

        await addIncidentHistory({
          incidentId: input.incidentId,
          action: "Report sent",
          details: `Report sent to ${input.recipients.length} recipients`,
          performedBy: ctx.user.id,
        });

        return { success: true, count: results.length };
      }),

    // الحصول على حالة الإرسالات
    getStatus: publicProcedure
      .input(z.object({ incidentId: z.number() }))
      .query(async ({ input }) => {
        const { getReportSends } = await import("./db");
        return await getReportSends(input.incidentId);
      }),
  }),
});

export type AppRouter = typeof appRouter;


