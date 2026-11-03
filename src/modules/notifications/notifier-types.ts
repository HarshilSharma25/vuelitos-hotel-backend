export interface BookingNoticePayload {
  code: string;
  contactName: string;
  contactEmail: string;
  accessToken?: string;
  pct?: number;
  hoursRemaining?: number;
}

export interface Notifier {
  sendBookingCreatedNotice(booking: BookingNoticePayload): Promise<void>;
  sendPaymentReminderNotice(booking: BookingNoticePayload): Promise<void>;
  sendPaymentExpiredNotice(booking: BookingNoticePayload): Promise<void>;
  sendAccessLinkNotice(booking: BookingNoticePayload): Promise<void>;
}
