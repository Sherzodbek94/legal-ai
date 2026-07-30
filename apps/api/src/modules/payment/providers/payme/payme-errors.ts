/**
 * Payme Merchant API errors.
 *
 * Payme speaks JSON-RPC 2.0 and, like CLICK, carries failure in the body at
 * HTTP 200. Its certification suite checks the exact code returned for each
 * failure mode, so these are not internal labels — they are the protocol.
 *
 * The localised `message` object is also mandatory. Payme's own UI shows the
 * string it gets back to the paying customer, in whichever of the three
 * languages their app is set to.
 */

export const PaymeErrorCode = {
  // --- JSON-RPC transport ---------------------------------------------------
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // --- Merchant API ---------------------------------------------------------
  /** Credentials missing or wrong. */
  INSUFFICIENT_PRIVILEGES: -32504,
  /** Amount does not match the order. */
  INVALID_AMOUNT: -31001,
  /** Transaction id is unknown to us. */
  TRANSACTION_NOT_FOUND: -31003,
  /** State transition is not legal from where the transaction is now. */
  UNABLE_TO_PERFORM: -31008,
  /** Cannot cancel: the order has already been delivered. */
  UNABLE_TO_CANCEL: -31007,

  /**
   * Account-field errors occupy -31099..-31050 and must name the offending
   * field in `data`, which is how Payme's UI highlights the right input.
   */
  ORDER_NOT_FOUND: -31050,
  ORDER_NOT_PAYABLE: -31051,
} as const;

export type PaymeErrorCodeValue =
  (typeof PaymeErrorCode)[keyof typeof PaymeErrorCode];

export interface PaymeLocalizedMessage {
  ru: string;
  uz: string;
  en: string;
}

export const PAYME_MESSAGES: Record<number, PaymeLocalizedMessage> = {
  [PaymeErrorCode.INSUFFICIENT_PRIVILEGES]: {
    ru: 'Недостаточно привилегий для выполнения операции',
    uz: 'Operatsiyani bajarish uchun huquqlar yetarli emas',
    en: 'Insufficient privileges to perform the operation',
  },
  [PaymeErrorCode.METHOD_NOT_FOUND]: {
    ru: 'Запрошенный метод не найден',
    uz: "So'ralgan metod topilmadi",
    en: 'Requested method not found',
  },
  [PaymeErrorCode.INVALID_PARAMS]: {
    ru: 'Неверные параметры запроса',
    uz: "Noto'g'ri so'rov parametrlari",
    en: 'Invalid request parameters',
  },
  [PaymeErrorCode.INTERNAL_ERROR]: {
    ru: 'Внутренняя ошибка сервера',
    uz: 'Server ichki xatosi',
    en: 'Internal server error',
  },
  [PaymeErrorCode.INVALID_AMOUNT]: {
    ru: 'Неверная сумма',
    uz: "Noto'g'ri summa",
    en: 'Invalid amount',
  },
  [PaymeErrorCode.TRANSACTION_NOT_FOUND]: {
    ru: 'Транзакция не найдена',
    uz: 'Tranzaksiya topilmadi',
    en: 'Transaction not found',
  },
  [PaymeErrorCode.UNABLE_TO_PERFORM]: {
    ru: 'Невозможно выполнить операцию',
    uz: 'Operatsiyani bajarib bolmaydi',
    en: 'Unable to perform operation',
  },
  [PaymeErrorCode.UNABLE_TO_CANCEL]: {
    ru: 'Невозможно отменить транзакцию: заказ выполнен',
    uz: 'Tranzaksiyani bekor qilib bolmaydi: buyurtma bajarilgan',
    en: 'Unable to cancel transaction: order already delivered',
  },
  [PaymeErrorCode.ORDER_NOT_FOUND]: {
    ru: 'Заказ не найден',
    uz: 'Buyurtma topilmadi',
    en: 'Order not found',
  },
  [PaymeErrorCode.ORDER_NOT_PAYABLE]: {
    ru: 'Заказ не может быть оплачен',
    uz: "Buyurtmani to'lab bo'lmaydi",
    en: 'Order cannot be paid',
  },
};

/** Payme's integer transaction states, which it expects echoed exactly. */
export const PaymeTransactionState = {
  CREATED: 1,
  PERFORMED: 2,
  CANCELED: -1,
  CANCELED_AFTER_PERFORM: -2,
} as const;

/**
 * A transaction older than this can no longer be performed.
 *
 * 12 hours is Payme's own timeout. Honouring it matters: without it we would
 * happily capture a transaction Payme has already written off, and the money
 * would never arrive.
 */
export const PAYME_TRANSACTION_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export interface PaymeRpcError {
  code: number;
  message: PaymeLocalizedMessage;
  /** Names the offending field for account errors. */
  data?: string;
}

/**
 * Thrown by handlers and converted into a JSON-RPC error envelope.
 *
 * A dedicated class rather than a plain object so it can travel up through the
 * normal `throw` path without every intermediate layer having to thread a
 * result type through.
 */
export class PaymeError extends Error {
  constructor(
    readonly code: number,
    readonly data?: string,
  ) {
    super(PAYME_MESSAGES[code]?.en ?? 'Payme error');
    this.name = 'PaymeError';
  }

  toRpcError(): PaymeRpcError {
    return {
      code: this.code,
      message: PAYME_MESSAGES[this.code] ?? {
        ru: 'Ошибка',
        uz: 'Xato',
        en: 'Error',
      },
      ...(this.data ? { data: this.data } : {}),
    };
  }
}

export interface PaymeRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export function paymeSuccess(id: number | string | null, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function paymeFailure(id: number | string | null, error: PaymeRpcError) {
  return { jsonrpc: '2.0', id: id ?? null, error };
}
