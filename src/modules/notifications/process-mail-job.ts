import { flightInternalClient } from '../../lib/flight-internal.js';
import { buildBookingMailPayload } from '../../lib/booking-mail-data.js';
import { logger } from '../../lib/logger.js';

export async function processMailJob(job: {
  name: string;
  data: Record<string, unknown>;
}) {
  const code = String(job.data.code || '');
  const recipient = String(job.data.recipient || '');
  const template = String(job.data.template || 'hotel-update');
  const attachConfirmationPdf = Boolean(job.data.attachConfirmationPdf);

  const accessToken =
    job.data.includeAccessToken && job.data.accessToken
      ? String(job.data.accessToken)
      : undefined;

  const mailData = await buildBookingMailPayload(code, accessToken);

  const locale = (job.data.locale as string) || mailData.locale;

  await flightInternalClient.sendHotelMail({
    template,
    recipient,
    locale,
    data: {
      ...mailData,
      customer_name: job.data.name || mailData.contact.name,
      extra: {
        pct: job.data.pct,
        hoursRemaining: job.data.hoursRemaining,
        staffMessage: job.data.staffMessage,
        approvedAmount: job.data.approvedAmount,
        approvedCurrency: job.data.approvedCurrency,
        rejectionReason: job.data.rejectionReason,
        refundReference: job.data.refundReference,
      },
      mail_event: job.name,
    },
    attach_confirmation_pdf: attachConfirmationPdf,
  });

  logger.info({ bookingCode: code, jobName: job.name, template }, '[MailWorker] sent hotel mail');
}
