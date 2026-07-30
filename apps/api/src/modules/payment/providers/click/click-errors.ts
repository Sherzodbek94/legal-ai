/**
 * CLICK SHOP-API result codes.
 *
 * The protocol carries failure in the response *body*, not the HTTP status: a
 * rejected callback is still `200 OK` with a negative `error`. Returning a 4xx
 * instead makes CLICK treat the callback as undelivered and retry it forever.
 */
export const ClickError = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INCORRECT_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  ORDER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  FAILED_TO_UPDATE_ORDER: -7,
  ERROR_IN_REQUEST: -8,
  TRANSACTION_CANCELLED: -9,
} as const;

export type ClickErrorCode = (typeof ClickError)[keyof typeof ClickError];

export const CLICK_ERROR_NOTES: Record<number, string> = {
  [ClickError.SUCCESS]: 'Success',
  [ClickError.SIGN_CHECK_FAILED]: 'SIGN CHECK FAILED',
  [ClickError.INCORRECT_AMOUNT]: 'Incorrect parameter amount',
  [ClickError.ACTION_NOT_FOUND]: 'Action not found',
  [ClickError.ALREADY_PAID]: 'Already paid',
  [ClickError.ORDER_NOT_FOUND]: 'Order does not exist',
  [ClickError.TRANSACTION_NOT_FOUND]: 'Transaction does not exist',
  [ClickError.FAILED_TO_UPDATE_ORDER]: 'Failed to update order',
  [ClickError.ERROR_IN_REQUEST]: 'Error in request from click',
  [ClickError.TRANSACTION_CANCELLED]: 'Transaction cancelled',
};

export interface ClickResponse {
  click_trans_id: number;
  merchant_trans_id: string;
  merchant_prepare_id?: number;
  merchant_confirm_id?: number;
  error: number;
  error_note: string;
}

export function clickResponse(
  clickTransId: string | number,
  merchantTransId: string,
  error: number,
  extra: { merchant_prepare_id?: number; merchant_confirm_id?: number } = {},
): ClickResponse {
  return {
    click_trans_id: Number(clickTransId) || 0,
    merchant_trans_id: merchantTransId ?? '',
    ...extra,
    error,
    error_note: CLICK_ERROR_NOTES[error] ?? 'Unknown error',
  };
}
