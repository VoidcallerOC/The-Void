import type { ApplicationStatus, ProfileVerificationStatus } from "./types.ts";

const REVIEWER_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["UNDER_REVIEW", "NEEDS_INFORMATION", "VERIFIED", "DECLINED"],
  UNDER_REVIEW: ["NEEDS_INFORMATION", "VERIFIED", "DECLINED", "UNDER_REVIEW"],
  NEEDS_INFORMATION: ["UNDER_REVIEW", "VERIFIED", "DECLINED"],
  VERIFIED: ["REVOKED"],
  DECLINED: [],
  REVOKED: [],
};

export function canReviewerTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return REVIEWER_TRANSITIONS[from].includes(to);
}

export function canApplicantRespond(status: ApplicationStatus): boolean {
  return status === "NEEDS_INFORMATION";
}

export function canApplicantReapply(status: ApplicationStatus | null): boolean {
  if (!status) return true;
  return status === "DECLINED" || status === "REVOKED";
}

export function profileStatusFromApplication(
  status: ApplicationStatus | null,
): ProfileVerificationStatus {
  if (!status) return "NOT_APPLIED";
  switch (status) {
    case "DRAFT":
      return "NOT_APPLIED";
    case "SUBMITTED":
    case "UNDER_REVIEW":
    case "NEEDS_INFORMATION":
      return "PENDING";
    case "VERIFIED":
      return "VERIFIED";
    case "DECLINED":
      return "DECLINED";
    case "REVOKED":
      return "REVOKED";
  }
}

export function isVerifiedStatus(status: ApplicationStatus | ProfileVerificationStatus | null): boolean {
  return status === "VERIFIED";
}

export function reviewerRequiresReason(to: ApplicationStatus): boolean {
  return to === "DECLINED" || to === "REVOKED" || to === "NEEDS_INFORMATION";
}
