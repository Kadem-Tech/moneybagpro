import { useMemo, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { SUPPORTED_VOLATILITY_MARKETS } from '@/utils/digit-strategy';
import {
    getLinkedAccounts,
    runBulkTradeAcrossAccounts,
    runBulkTradesOnActiveAccount,
    type TBulkTradeParameters,
    type TBulkTradeResult,
    type TLinkedAccount,
} from './bulk-trade-executor';
import './bulk-trading.scss';

const CONTRACT_TYPES = [
    { label: 'Rise', value: 'CALL' },
    { label: 'Fall', value: 'PUT' },
    { label: 'Digit Over', value: 'DIGITOVER' },
    { label: 'Digit Under', value: 'DIGITUNDER' },
    { label: 'Digit Even', value: 'DIGITEVEN' },
    { label: 'Digit Odd', value: 'DIGITODD' },
];

const DEFAULT_TRADE: TBulkTradeParameters = {
    symbol: SUPPORTED_VOLATILITY_MARKETS[0].symbol,
    contract_type: 'CALL',
    duration: 5,
    duration_unit: 't',
    stake: 1,
};

type TBatchTrade = TBulkTradeParameters & { id: string };

const newBatchTrade = (): TBatchTrade => ({
    ...DEFAULT_TRADE,
    id: `trade-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
});

const TradeFieldsEditor = ({
    trade,
    onChange,
}: {
    trade: TBulkTradeParameters;
    onChange: (next: TBulkTradeParameters) => void;
}) => {
    const needs_barrier = trade.contract_type === 'DIGITOVER' || trade.contract_type === 'DIGITUNDER';

    return (
        <div className='bulk-trading__fields'>
            <label className='bulk-trading__field'>
                <span>Market</span>
                <select value={trade.symbol} onChange={event => onChange({ ...trade, symbol: event.target.value })}>
                    {SUPPORTED_VOLATILITY_MARKETS.map(market => (
                        <option key={market.symbol} value={market.symbol}>
                            {market.label}
                        </option>
                    ))}
                </select>
            </label>
            <label className='bulk-trading__field'>
                <span>Trade type</span>
                <select
                    value={trade.contract_type}
                    onChange={event => onChange({ ...trade, contract_type: event.target.value })}
                >
                    {CONTRACT_TYPES.map(type => (
                        <option key={type.value} value={type.value}>
                            {type.label}
                        </option>
                    ))}
                </select>
            </label>
            {needs_barrier && (
                <label className='bulk-trading__field'>
                    <span>Digit barrier</span>
                    <input
                        inputMode='numeric'
                        max={9}
                        min={0}
                        value={trade.barrier ?? '5'}
                        onChange={event => onChange({ ...trade, barrier: event.target.value })}
                    />
                </label>
            )}
            <label className='bulk-trading__field'>
                <span>Duration (ticks)</span>
                <input
                    inputMode='numeric'
                    min={1}
                    value={trade.duration}
                    onChange={event => onChange({ ...trade, duration: Number(event.target.value) || 1 })}
                />
            </label>
            <label className='bulk-trading__field'>
                <span>Stake</span>
                <input
                    inputMode='decimal'
                    min={0.35}
                    step={0.01}
                    value={trade.stake}
                    onChange={event => onChange({ ...trade, stake: Number(event.target.value) || 0 })}
                />
            </label>
        </div>
    );
};

const initials = (loginid: string) => loginid.replace(/[0-9]/g, '').slice(0, 2).toUpperCase() || loginid.slice(0, 2).toUpperCase();

const BulkTrading = observer(() => {
    const { client, run_panel, summary_card, transactions } = useStore();
    const [mode, setMode] = useState<'accounts' | 'batch'>('accounts');

    // Mirrors Manual Trading's pushContract: writes each settled contract
    // into the app's shared Trade History / Journal so trades placed here
    // show up there too, instead of only inside this page's own results list.
    const pushContract = (data: Record<string, any>) => {
        try {
            transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
            run_panel.onBotContractEvent(data);
            summary_card.onBotContractEvent(data);
        } catch {
            // Bulk Trading should not fail because a side panel observer is unavailable.
        }
    };

    // Mode 1: same trade, several of the user's own linked accounts.
    const linked_accounts = useMemo<TLinkedAccount[]>(() => getLinkedAccounts(), []);
    const [selectedLoginids, setSelectedLoginids] = useState<string[]>(() =>
        linked_accounts.map(account => account.loginid)
    );
    const all_selected = linked_accounts.length > 0 && selectedLoginids.length === linked_accounts.length;
    const [accountsTrade, setAccountsTrade] = useState<TBulkTradeParameters>(DEFAULT_TRADE);
    const [accountsResults, setAccountsResults] = useState<TBulkTradeResult[] | null>(null);
    const [isRunningAccounts, setIsRunningAccounts] = useState(false);

    // Mode 2: several different trades, one account (the one active in the app).
    const [batchTrades, setBatchTrades] = useState<TBatchTrade[]>([newBatchTrade(), newBatchTrade()]);
    const [batchResults, setBatchResults] = useState<Record<string, { ok: boolean; message: string }> | null>(null);
    const [isRunningBatch, setIsRunningBatch] = useState(false);

    const toggleAccount = (loginid: string) => {
        setSelectedLoginids(current =>
            current.includes(loginid) ? current.filter(id => id !== loginid) : [...current, loginid]
        );
    };

    const toggleAll = () => {
        setSelectedLoginids(all_selected ? [] : linked_accounts.map(account => account.loginid));
    };

    // Only counts trades that actually settled as a win — a successful purchase alone isn't a win.
    const accounts_won = accountsResults?.filter(result => result.won).length ?? 0;
    const batch_won = batchResults ? Object.values(batchResults).filter(result => result.won).length : 0;

    const handleRunAccounts = async () => {
        const accounts = linked_accounts.filter(account => selectedLoginids.includes(account.loginid));
        if (!accounts.length) return;

        setIsRunningAccounts(true);
        setAccountsResults(null);
        try {
            const results = await runBulkTradeAcrossAccounts(accounts, accountsTrade);
            setAccountsResults(results);
        } finally {
            setIsRunningAccounts(false);
        }
    };

    const handleRunBatch = async () => {
        if (!batchTrades.length) return;

        setIsRunningBatch(true);
        setBatchResults(null);
        try {
            const results = await runBulkTradesOnActiveAccount(batchTrades, {
                onBuy: (_trade_id, snapshot) => pushContract(snapshot),
                onSettled: (_trade_id, snapshot) => pushContract(snapshot),
            });
            setBatchResults(results);
        } finally {
            setIsRunningBatch(false);
        }
    };

    return (
        <div className='bulk-trading-page'>
            <div className='bulk-trading__hero'>
                <div>
                    <h2 className='bulk-trading__title'>Bulk Trading</h2>
                    <p className='bulk-trading__subtitle'>Fire the same trade across accounts, or several trades at once.</p>
                </div>
                <div className='bulk-trading__stats'>
                    <div className='bulk-trading__stat'>
                        <span className='bulk-trading__stat-value'>{linked_accounts.length}</span>
                        <span className='bulk-trading__stat-label'>Linked accounts</span>
                    </div>
                    <div className='bulk-trading__stat'>
                        <span className='bulk-trading__stat-value'>{selectedLoginids.length}</span>
                        <span className='bulk-trading__stat-label'>Selected</span>
                    </div>
                    <div className='bulk-trading__stat'>
                        <span className='bulk-trading__stat-value'>{mode === 'accounts' ? accounts_won : batch_won}</span>
                        <span className='bulk-trading__stat-label'>Last run wins</span>
                    </div>
                </div>
            </div>

            <div className='bulk-trading__mode-toggle'>
                <button
                    className={classNames('bulk-trading__mode-btn', { 'bulk-trading__mode-btn--active': mode === 'accounts' })}
                    onClick={() => setMode('accounts')}
                    type='button'
                >
                    <span className='bulk-trading__mode-btn-title'>Same trade, multiple accounts</span>
                    <span className='bulk-trading__mode-btn-desc'>Mirror one trade across every account you pick</span>
                </button>
                <button
                    className={classNames('bulk-trading__mode-btn', { 'bulk-trading__mode-btn--active': mode === 'batch' })}
                    onClick={() => setMode('batch')}
                    type='button'
                >
                    <span className='bulk-trading__mode-btn-title'>Multiple trades, one account</span>
                    <span className='bulk-trading__mode-btn-desc'>Stack different trades on your active account</span>
                </button>
            </div>

            {mode === 'accounts' && (
                <section className='bulk-trading__panel'>
                    <p className='bulk-trading__hint'>
                        Runs the same trade on each account you select below, at the same time, each with its own login. Only
                        accounts currently linked to this browser session are listed.
                    </p>

                    {!linked_accounts.length ? (
                        <p className='bulk-trading__empty'>
                            No linked accounts found. Log in with an account that has multiple accounts linked to use this
                            mode.
                        </p>
                    ) : (
                        <>
                            <div className='bulk-trading__account-list-header'>
                                <span>{linked_accounts.length} account{linked_accounts.length === 1 ? '' : 's'} available</span>
                                <button className='bulk-trading__select-all-btn' onClick={toggleAll} type='button'>
                                    {all_selected ? 'Deselect all' : 'Select all'}
                                </button>
                            </div>
                            <div className='bulk-trading__account-list'>
                                {linked_accounts.map(account => {
                                    const checked = selectedLoginids.includes(account.loginid);
                                    return (
                                        <label
                                            key={account.loginid}
                                            className={classNames('bulk-trading__account', {
                                                'bulk-trading__account--checked': checked,
                                            })}
                                        >
                                            <input checked={checked} onChange={() => toggleAccount(account.loginid)} type='checkbox' />
                                            <span className='bulk-trading__account-avatar'>{initials(account.loginid)}</span>
                                            <span className='bulk-trading__account-info'>
                                                <span className='bulk-trading__account-loginid'>{account.loginid}</span>
                                                <span className='bulk-trading__account-meta'>
                                                    {account.currency ?? ''}
                                                    {account.loginid === client?.loginid ? ' · Current' : ''}
                                                </span>
                                            </span>
                                            {account.is_virtual && <span className='bulk-trading__badge bulk-trading__badge--demo'>Demo</span>}
                                        </label>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    <TradeFieldsEditor trade={accountsTrade} onChange={setAccountsTrade} />

                    <button
                        className='bulk-trading__run-btn'
                        disabled={isRunningAccounts || !selectedLoginids.length}
                        onClick={handleRunAccounts}
                        type='button'
                    >
                        {isRunningAccounts ? (
                            <span className='bulk-trading__spinner' />
                        ) : (
                            `Place on ${selectedLoginids.length} account${selectedLoginids.length === 1 ? '' : 's'}`
                        )}
                    </button>

                    {accountsResults && (
                        <ul className='bulk-trading__results'>
                            {accountsResults.map(result => (
                                <li
                                    key={result.loginid}
                                    className={classNames('bulk-trading__result', {
                                        'bulk-trading__result--ok': result.won || (result.ok && result.won === undefined),
                                        'bulk-trading__result--error': !result.ok || result.won === false,
                                    })}
                                >
                                    <span className='bulk-trading__result-icon'>
                                        {result.ok ? (result.won ? '✓' : result.is_sold ? '✕' : '…') : '✕'}
                                    </span>
                                    <strong>{result.loginid}</strong>
                                    <span>{result.message}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}

            {mode === 'batch' && (
                <section className='bulk-trading__panel'>
                    <p className='bulk-trading__hint'>
                        Places several different trades at once on your currently active account.
                    </p>

                    {batchTrades.map((trade, index) => (
                        <div className='bulk-trading__batch-item' key={trade.id}>
                            <div className='bulk-trading__batch-item-header'>
                                <span>Trade {index + 1}</span>
                                {batchTrades.length > 1 && (
                                    <button
                                        className='bulk-trading__remove-btn'
                                        onClick={() => setBatchTrades(current => current.filter(item => item.id !== trade.id))}
                                        type='button'
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>
                            <TradeFieldsEditor
                                trade={trade}
                                onChange={next =>
                                    setBatchTrades(current =>
                                        current.map(item => (item.id === trade.id ? { ...next, id: item.id } : item))
                                    )
                                }
                            />
                            {batchResults?.[trade.id] && (
                                <p
                                    className={classNames('bulk-trading__batch-result', {
                                        'bulk-trading__result--ok': batchResults[trade.id].won,
                                        'bulk-trading__result--error':
                                            !batchResults[trade.id].ok || batchResults[trade.id].won === false,
                                    })}
                                >
                                    {batchResults[trade.id].message}
                                </p>
                            )}
                        </div>
                    ))}

                    <button
                        className='bulk-trading__add-btn'
                        onClick={() => setBatchTrades(current => [...current, newBatchTrade()])}
                        type='button'
                    >
                        + Add another trade
                    </button>

                    <button
                        className='bulk-trading__run-btn'
                        disabled={isRunningBatch || !batchTrades.length}
                        onClick={handleRunBatch}
                        type='button'
                    >
                        {isRunningBatch ? <span className='bulk-trading__spinner' /> : `Place ${batchTrades.length} trades`}
                    </button>
                </section>
            )}
        </div>
    );
});

export default BulkTrading;
