import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { api_base } from '@/external/bot-skeleton';
import { streamContractUntilSettled } from '@/utils/trade-purchase';
import { safeSubscribe } from '@/utils/websocket-handler';

/**
 * Deriv's copy trading works on the currently authenticated (follower's own)
 * connection — unlike Bulk Trading, it does NOT need a separate socket per
 * account. The follower stays logged in as themselves and simply passes the
 * TRADER's shared read-only API token as the `copy_start` value; Deriv's
 * backend then mirrors that trader's trades onto the follower's account,
 * scaled to the follower's own balance. `copy_stop` takes the same token to
 * end it.
 */

export type TStartCopyTradingParams = {
    /** The trader's shared, copy-trading-enabled read-only API token. */
    trader_token: string;
    /** Optional: restrict which symbols get copied, e.g. ['R_50', 'frxUSDJPY']. */
    assets?: string[];
    /** Optional: restrict which contract types get copied, e.g. ['CALL', 'PUT']. */
    trade_types?: string[];
    /** Optional: skip any trade below this stake. */
    min_trade_stake?: number;
    /** Optional: skip any trade above this stake. */
    max_trade_stake?: number;
};

export type TCopyTradingResult = {
    ok: boolean;
    message: string;
};

export type TFollowedTrader = {
    loginid?: string;
    token?: string;
    assets?: string[];
    trade_types?: string[];
    min_trade_stake?: number | null;
    max_trade_stake?: number | null;
};

export type TCopier = {
    loginid: string;
};

export type TCopyTradingList = {
    traders: TFollowedTrader[];
    copiers: TCopier[];
};

export type TTraderStatistics = {
    active_since?: number;
    avg_duration?: number;
    avg_loss?: number;
    avg_profit?: number;
    copiers?: number;
    performance_probability?: number;
    total_trades?: number;
    trades_profitable?: number;
    trades_breakdown?: Record<string, number>;
    monthly_profitable_trades?: Record<string, number>;
};

const send = (request: Record<string, unknown>) => (api_base.api as any)?.send?.(request);

const errorMessage = (response: any, fallback: string) => {
    const api_error = response?.error;
    if (!api_error) return fallback;
    return api_error.code ? getLocalizedErrorMessage(api_error.code, api_error) : api_error.message || fallback;
};

/** Starts copying a trader's trades onto the currently active account. */
export const startCopyTrading = async (params: TStartCopyTradingParams): Promise<TCopyTradingResult> => {
    if (!api_base.is_authorized) {
        return { ok: false, message: 'You must be logged in to start copy trading.' };
    }
    if (!params.trader_token?.trim()) {
        return { ok: false, message: 'A trader token is required.' };
    }

    try {
        const response = await send({
            copy_start: params.trader_token.trim(),
            ...(params.assets?.length ? { assets: params.assets } : {}),
            ...(params.trade_types?.length ? { trade_types: params.trade_types } : {}),
            ...(params.min_trade_stake !== undefined ? { min_trade_stake: params.min_trade_stake } : {}),
            ...(params.max_trade_stake !== undefined ? { max_trade_stake: params.max_trade_stake } : {}),
        });

        if (response?.error) {
            return { ok: false, message: errorMessage(response, 'Could not start copy trading.') };
        }
        if (response?.copy_start === 1) {
            return { ok: true, message: 'Now copying this trader.' };
        }
        return { ok: false, message: 'Unexpected response starting copy trading.' };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not start copy trading.' };
    }
};

/** Stops copying a trader identified by the same token used to start. */
export const stopCopyTrading = async (trader_token: string): Promise<TCopyTradingResult> => {
    if (!trader_token?.trim()) {
        return { ok: false, message: 'A trader token is required.' };
    }

    try {
        const response = await send({ copy_stop: trader_token.trim() });

        if (response?.error) {
            return { ok: false, message: errorMessage(response, 'Could not stop copy trading.') };
        }
        return { ok: true, message: 'Stopped copying this trader.' };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not stop copy trading.' };
    }
};

export type TCopiedTransactionCallbacks = {
    /** Fired the moment Deriv reports a new buy on the account — before it settles. */
    onBuy?: (snapshot: Record<string, any>) => void;
    /** Fired once that copied contract settles (won or lost). */
    onSettled?: (snapshot: Record<string, any>) => void;
};

/**
 * Copy Trading executes on Deriv's backend directly onto the follower's own
 * account — the app never receives a `buy` response for these trades the
 * way Manual/Bulk Trading do (there's no `copy_start` "buy result" to read).
 * The only way to know a copied trade happened at all is to watch the
 * account's own `transaction` stream, which reports every buy/sell on the
 * account, and thread each new contract through the same settlement
 * tracking used everywhere else so it shows up in Trade History with a
 * Won/Lost result.
 *
 * Callers should start this while at least one trader is being followed,
 * and stop it (call the returned function) once no traders remain.
 */
export const watchCopiedTransactions = (callbacks: TCopiedTransactionCallbacks) => {
    const seen_contract_ids = new Set<number>();

    const observable = (api_base.api as any)?.subscribe?.({ transaction: 1, subscribe: 1 });
    const subscription = safeSubscribe(observable, (data: any) => {
        const transaction = data?.transaction;
        if (!transaction || transaction.action !== 'buy' || !transaction.contract_id) return;
        if (seen_contract_ids.has(transaction.contract_id)) return;
        seen_contract_ids.add(transaction.contract_id);

        const fallback = {
            buy_price: Math.abs(Number(transaction.amount ?? 0)),
            contract_id: transaction.contract_id,
            currency: transaction.currency,
            date_start: transaction.purchase_time ?? transaction.transaction_time,
            display_name: transaction.symbol,
            shortcode: transaction.longcode,
            underlying_symbol: transaction.symbol,
            transaction_ids: { buy: transaction.transaction_id },
        };

        callbacks.onBuy?.(fallback);

        void streamContractUntilSettled({
            contractId: transaction.contract_id,
            fallback,
            source: 'Copy Trading',
        }).then(settled => callbacks.onSettled?.(settled));
    });

    return () => {
        subscription?.unsubscribe?.();
        seen_contract_ids.clear();
    };
};

/** Lists traders the current account is copying, and copiers following it. */
export const getCopyTradingList = async (): Promise<TCopyTradingList | null> => {
    if (!api_base.is_authorized) return null;

    try {
        const response = await send({ copytrading_list: 1 });
        if (response?.error) return null;

        return {
            traders: response?.copytrading_list?.traders ?? [],
            copiers: response?.copytrading_list?.copiers ?? [],
        };
    } catch {
        return null;
    }
};

/** Pulls a trader's performance stats so a prospective follower can vet them before copying. */
export const getTraderStatistics = async (trader_id: string): Promise<TTraderStatistics | null> => {
    if (!trader_id?.trim()) return null;

    try {
        const response = await send({ copytrading_statistics: 1, trader_id: trader_id.trim() });
        if (response?.error) return null;

        return response?.copytrading_statistics ?? null;
    } catch {
        return null;
    }
};
