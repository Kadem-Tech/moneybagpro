import { getDomainConfig } from '@/components/shared';
import { getSymbolRequestField } from '@/external/bot-skeleton/services/api/legacy-request';
import { buyContractForUi, normalizeTradeParameters, streamContractUntilSettled } from '@/utils/trade-purchase';

const LEGACY_WS_SERVER = 'wss://ws.derivws.com/websockets/v3';
const RESPONSE_TIMEOUT_MS = 15000;

export type TLinkedAccount = {
    loginid: string;
    token: string;
    currency?: string;
    is_virtual?: boolean;
};

export type TBulkTradeParameters = {
    symbol: string;
    contract_type: string;
    duration: number;
    duration_unit: string;
    stake: number;
    barrier?: string;
};

export type TBulkTradeResult = {
    loginid: string;
    ok: boolean;
    message: string;
    buy_price?: number;
    payout?: number;
    contract_id?: number;
    /** Populated once the contract settles on that account's own connection. */
    profit?: number;
    is_sold?: boolean;
    won?: boolean;
};

/** How long to wait, per account, for a fired contract to settle before giving up on the result (not the trade itself — it already went through). */
const SETTLEMENT_TIMEOUT_MS = 120000;

/**
 * Reads the linked-accounts token map that Deriv's OAuth redirect stores in
 * localStorage (loginid -> token), and pairs it with the friendlier account
 * metadata also stored there, so the caller gets a usable, labeled list of
 * every account the current browser session has tokens for.
 */
export const getLinkedAccounts = (): TLinkedAccount[] => {
    try {
        const accounts_list = JSON.parse(localStorage.getItem('accountsList') ?? '{}') as Record<string, string>;
        const client_accounts = JSON.parse(localStorage.getItem('clientAccounts') ?? '{}') as Record<
            string,
            { currency?: string; is_virtual?: boolean }
        >;

        return Object.entries(accounts_list)
            .filter(([, token]) => !!token)
            .map(([loginid, token]) => ({
                loginid,
                token,
                currency: client_accounts[loginid]?.currency,
                is_virtual: client_accounts[loginid]?.is_virtual,
            }));
    } catch {
        return [];
    }
};

const getLegacySocketURL = () => {
    const { appId } = getDomainConfig();
    return `${LEGACY_WS_SERVER}?app_id=${encodeURIComponent(appId)}`;
};

/**
 * Sends a single request/response pair over a plain WebSocket and resolves
 * with the parsed response, matched by `req_id`. Used to run a short-lived,
 * independent connection per linked account for bulk execution — this is
 * deliberately separate from the app's single shared `api_base` connection
 * so bulk trading can never disturb the account the user is actively
 * viewing elsewhere in the app.
 */
const sendOnSocket = (socket: WebSocket, request: Record<string, unknown>): Promise<any> => {
    const req_id = Math.floor(Math.random() * 1_000_000_000);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.removeEventListener('message', onMessage);
            reject(new Error('Request timed out.'));
        }, RESPONSE_TIMEOUT_MS);

        const onMessage = (event: MessageEvent) => {
            let data: any;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            if (data.req_id !== req_id) return;

            clearTimeout(timeout);
            socket.removeEventListener('message', onMessage);
            resolve(data);
        };

        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({ ...request, req_id }));
    });
};

const openSocket = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const socket = new WebSocket(getLegacySocketURL());
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Connection timed out.'));
        }, RESPONSE_TIMEOUT_MS);

        socket.onopen = () => {
            clearTimeout(timeout);
            resolve(socket);
        };
        socket.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('Could not connect.'));
        };
    });

/**
 * Waits for a contract bought on an isolated per-account socket to settle,
 * by subscribing to proposal_open_contract on that same socket (the app's
 * shared `streamContractUntilSettled` can't be reused here — it only knows
 * about the main session's own connection, not these other accounts').
 * Resolves with `is_sold: false` on timeout rather than rejecting, since the
 * trade itself already succeeded — a missing result shouldn't be reported
 * as a failed purchase.
 */
const waitForContractSettlement = (
    socket: WebSocket,
    contractId: number,
    timeoutMs: number
): Promise<{ is_sold: boolean; profit?: number; status?: string }> =>
    new Promise(resolve => {
        let settled = false;

        const finish = (result: { is_sold: boolean; profit?: number; status?: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.removeEventListener('message', onMessage);
            resolve(result);
        };

        const timeout = setTimeout(() => finish({ is_sold: false }), timeoutMs);

        const onMessage = (event: MessageEvent) => {
            let data: any;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            const contract = data?.proposal_open_contract;
            if (data?.msg_type !== 'proposal_open_contract' || !contract) return;
            if (Number(contract.contract_id) !== Number(contractId)) return;

            if (contract.is_sold) {
                finish({ is_sold: true, profit: Number(contract.profit ?? 0), status: contract.status });
            }
        };

        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
    });

const buildTradeRequestParameters = (trade: TBulkTradeParameters, webSocketURL?: string) => {
    // Mode 1 (executeTradeOnAccount) always connects over its own dedicated
    // legacy socket (LEGACY_WS_SERVER, /websockets/v3), independent of
    // whatever connection type the main app session happens to be using
    // right now — that call passes LEGACY_WS_SERVER explicitly. Mode 2
    // (runBulkTradesOnActiveAccount) instead sends over the main app's own
    // live connection via buyContractForUi, so it must NOT be forced to
    // legacy — it leaves webSocketURL undefined and lets
    // getSymbolRequestField fall back to whatever that connection actually
    // is. Without this distinction, forcing legacy everywhere would send
    // { symbol } to a modern PKCE-flow connection that expects
    // { underlying_symbol }, breaking Mode 2 the same way omitting it
    // entirely was breaking Mode 1.
    const symbol_field = getSymbolRequestField(trade.symbol, webSocketURL);

    // normalizeTradeParameters independently re-resolves the symbol field
    // from whatever webSocketURL it's given (defaulting to the ambient
    // main-session URL when omitted). If webSocketURL isn't forwarded here,
    // Mode 1's correctly-computed { symbol } above gets silently discarded
    // and recomputed against the main session's connection type instead of
    // LEGACY_WS_SERVER — reintroducing the same "wrong symbol field" failure
    // this file was already fixed for once, one layer removed.
    return normalizeTradeParameters(
        {
            ...symbol_field,
            contract_type: trade.contract_type,
            duration: trade.duration,
            duration_unit: trade.duration_unit,
            amount: trade.stake,
            basis: 'stake',
            barrier: trade.barrier || undefined,
        },
        webSocketURL
    );
};

/**
 * Runs one trade on one account, over its own short-lived WebSocket
 * connection authorized with that account's own token. Never touches the
 * app's shared session.
 */
export const executeTradeOnAccount = async (
    account: TLinkedAccount,
    trade: TBulkTradeParameters
): Promise<TBulkTradeResult> => {
    let socket: WebSocket | undefined;

    try {
        socket = await openSocket();

        const auth_response = await sendOnSocket(socket, { authorize: account.token });
        if (auth_response.error) {
            return { loginid: account.loginid, ok: false, message: auth_response.error.message || 'Authorization failed.' };
        }

        const parameters = buildTradeRequestParameters(trade, LEGACY_WS_SERVER);
        const proposal_response = await sendOnSocket(socket, { proposal: 1, ...parameters });
        if (proposal_response.error) {
            return { loginid: account.loginid, ok: false, message: proposal_response.error.message || 'Could not get a price.' };
        }

        const proposal = proposal_response.proposal;
        const ask_price = Number(proposal?.ask_price ?? trade.stake);

        const buy_response = await sendOnSocket(socket, { buy: proposal.id, price: ask_price });
        if (buy_response.error) {
            return { loginid: account.loginid, ok: false, message: buy_response.error.message || 'Purchase failed.' };
        }

        const buy = buy_response.buy;
        const settlement = buy?.contract_id
            ? await waitForContractSettlement(socket, buy.contract_id, SETTLEMENT_TIMEOUT_MS)
            : { is_sold: false as const };

        return {
            loginid: account.loginid,
            ok: true,
            message: settlement.is_sold
                ? `${(settlement.profit ?? 0) >= 0 ? 'Won' : 'Lost'} ${Math.abs(settlement.profit ?? 0).toFixed(2)}`
                : 'Purchased · result still pending.',
            buy_price: Number(buy?.buy_price),
            payout: Number(buy?.payout),
            contract_id: buy?.contract_id,
            profit: settlement.profit,
            is_sold: settlement.is_sold,
            won: settlement.is_sold ? (settlement.profit ?? 0) >= 0 : undefined,
        };
    } catch (error) {
        return { loginid: account.loginid, ok: false, message: error instanceof Error ? error.message : 'Unknown error.' };
    } finally {
        socket?.close();
    }
};

/**
 * Mode 1: fire the same trade across several of the user's own linked
 * accounts, in parallel, each over its own connection.
 */
export const runBulkTradeAcrossAccounts = async (
    accounts: TLinkedAccount[],
    trade: TBulkTradeParameters
): Promise<TBulkTradeResult[]> => Promise.all(accounts.map(account => executeTradeOnAccount(account, trade)));

export type TBulkBatchCallbacks = {
    /** Fired the instant a trade in the batch is bought, before it settles — for pushing into Trade History right away. */
    onBuy?: (trade_id: string, snapshot: Record<string, any>) => void;
    /** Fired once that trade's contract settles (won or lost) — for updating Trade History with the final result. */
    onSettled?: (trade_id: string, snapshot: Record<string, any>) => void;
};

export type TBulkBatchResult = {
    ok: boolean;
    message: string;
    profit?: number;
    won?: boolean;
};

/**
 * Mode 2: fire several different trades on the single account the user is
 * currently authorized on in the main app. Reuses the same purchase path as
 * Manual Trading (`buyContractForUi` + `streamContractUntilSettled`) so
 * behaviour — proposal, balance checks, error messages, settlement, and
 * Trade History visibility — stays identical to a normal single trade.
 */
export const runBulkTradesOnActiveAccount = async (
    trades: (TBulkTradeParameters & { id: string })[],
    callbacks?: TBulkBatchCallbacks
): Promise<Record<string, TBulkBatchResult>> => {
    const entries = await Promise.all(
        trades.map(async trade => {
            try {
                const parameters = buildTradeRequestParameters(trade);
                const fallback = {
                    buy_price: trade.stake,
                    date_start: Math.floor(Date.now() / 1000),
                    underlying_symbol: trade.symbol,
                    shortcode: `BULK_${trade.contract_type}_${trade.symbol}`,
                    contract_type: trade.contract_type,
                };

                const buy = await buyContractForUi({ parameters, price: trade.stake, source: 'Bulk Trading' });
                const buySnapshot = {
                    ...fallback,
                    buy_price: buy.buy_price,
                    contract_id: buy.contract_id,
                    transaction_ids: { buy: buy.transaction_id },
                };
                callbacks?.onBuy?.(trade.id, buySnapshot);

                const settled = await streamContractUntilSettled({
                    contractId: buy.contract_id,
                    fallback: buySnapshot,
                    source: 'Bulk Trading',
                });
                callbacks?.onSettled?.(trade.id, settled);

                const profit = Number(settled.profit ?? 0);
                return [
                    trade.id,
                    {
                        ok: true,
                        message: `${profit >= 0 ? 'Won' : 'Lost'} ${Math.abs(profit).toFixed(2)}`,
                        profit,
                        won: profit >= 0,
                    },
                ] as const;
            } catch (error) {
                return [trade.id, { ok: false, message: error instanceof Error ? error.message : 'Unknown error.' }] as const;
            }
        })
    );

    return Object.fromEntries(entries);
};
