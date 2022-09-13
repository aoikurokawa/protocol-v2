import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { PublicKey } from '@solana/web3.js';

import {
	Wallet,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	Admin,
	ClearingHouse,
	convertToNumber,
	MARK_PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	QUOTE_PRECISION,
	ClearingHouseUser,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	printTxLogs,
	getFeedData,
	sleep,
} from './testHelpers';
import { AMM_RESERVE_PRECISION, isVariant, MARGIN_PRECISION } from '../sdk';
import {
	Keypair,
	sendAndConfirmTransaction,
	Transaction,
} from '@solana/web3.js';

async function depositToFeePoolFromIF(
	amount: number,
	clearingHouse: Admin,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());
	const state = await clearingHouse.getStateAccount();
	const tokenIx = Token.createTransferInstruction(
		TOKEN_PROGRAM_ID,
		userUSDCAccount.publicKey,
		state.insuranceVault,
		clearingHouse.provider.wallet.publicKey,
		// usdcMint.publicKey,
		[],
		ifAmount.toNumber()
	);

	await sendAndConfirmTransaction(
		clearingHouse.provider.connection,
		new Transaction().add(tokenIx),
		// @ts-ignore
		[clearingHouse.provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);

	// // send $50 to market from IF
	const txSig00 = await clearingHouse.withdrawFromInsuranceVaultToMarket(
		new BN(0),
		ifAmount
	);
	console.log(txSig00);
}

describe('delist market, liquidation of expired position', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let clearingHouseLoser: ClearingHouse;
	let clearingHouseLoserUser: ClearingHouseUser;

	let liquidatorClearingHouse: ClearingHouse;
	let liquidatorClearingHouseWSOLAccount: PublicKey;
	let liquidatorClearingHouseWUSDCAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(AMM_RESERVE_PRECISION.toNumber() / 10000);
	const ammInitialQuoteAssetReserve = new anchor.BN(9 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(9 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(1000 * 10 ** 6);
	const userKeypair = new Keypair();

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(10)),
			provider
		);

		solOracle = await mockOracle(43.1337);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(clearingHouse, solOracle);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(42_500),
			undefined,
			1000,
			900 // easy to liq
		);

		// await clearingHouse.updateMarketBaseSpread(new BN(0), 2000);
		// await clearingHouse.updateCurveUpdateIntensity(new BN(0), 100);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		userUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		clearingHouseLoser = new Admin({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});
		await clearingHouseLoser.subscribe();
		await clearingHouseLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		clearingHouseLoserUser = new ClearingHouseUser({
			clearingHouse: clearingHouseLoser,
			userAccountPublicKey: await clearingHouseLoser.getUserAccountPublicKey(),
		});
		await clearingHouseLoserUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseLoser.unsubscribe();
		await clearingHouseLoserUser.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user negative pnl', async () => {
		await depositToFeePoolFromIF(1000, clearingHouse, userUSDCAccount);

		try {
			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				BASE_PRECISION,
				new BN(0),
				new BN(0)
			);
		} catch (e) {
			console.log('clearingHouse.openPosition');

			console.error(e);
		}

		const uL = clearingHouseLoserUser.getUserAccount();
		console.log(
			'uL.spotPositions[0].balance:',
			uL.spotPositions[0].balance.toString()
		);
		assert(uL.spotPositions[0].balance.eq(new BN(1000 * 1e6)));

		const bank0Value = clearingHouseLoserUser.getSpotMarketAssetValue(
			new BN(0)
		);
		console.log('uL.bank0Value:', bank0Value.toString());
		assert(bank0Value.eq(new BN(1000 * 1e6)));

		const clearingHouseLoserUserValue = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('clearingHouseLoserUserValue:', clearingHouseLoserUserValue);
		assert(clearingHouseLoserUserValue == 1000); // ??

		// todo
		try {
			const txSig = await clearingHouseLoser.openPosition(
				PositionDirection.LONG,
				BASE_PRECISION.mul(new BN(205)),
				new BN(0),
				new BN(0)
			);
			await printTxLogs(connection, txSig);
		} catch (e) {
			console.log('failed clearingHouseLoserc.openPosition');

			console.error(e);
		}

		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserLeverage = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: new BN(0),
			}),
			MARK_PRICE_PRECISION
		);

		console.log(
			'clearingHouseLoserUser.getLeverage:',
			clearingHouseLoserUserLeverage,
			'clearingHouseLoserUserLiqPrice:',
			clearingHouseLoserUserLiqPrice
		);

		assert(clearingHouseLoserUserLeverage == 7.8486);
		assert(clearingHouseLoserUserLiqPrice < 41);
		assert(clearingHouseLoserUserLiqPrice > 40.5);

		const market00 = clearingHouse.getPerpMarketAccount(new BN(0));
		assert(market00.amm.feePool.balance.eq(new BN(1000000000)));

		const bank0Value1p5 = clearingHouseLoserUser.getSpotMarketAssetValue(
			new BN(0)
		);
		console.log('uL.bank0Value1p5:', bank0Value1p5.toString());

		const clearingHouseLoserUserValue1p5 = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log(
			'clearingHouseLoserUserValue1p5:',
			clearingHouseLoserUserValue1p5
		);

		// sol tanks 90%
		await clearingHouse.moveAmmToPrice(
			new BN(0),
			new BN(40.5 * MARK_PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, 40.5, solOracle);
		console.log('price move to $40.5');

		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserLeverage2 = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice2 = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: new BN(0),
			}),
			MARK_PRICE_PRECISION
		);

		const bank0Value2 = clearingHouseLoserUser.getSpotMarketAssetValue(
			new BN(0)
		);
		console.log('uL.bank0Value2:', bank0Value2.toString());

		const clearingHouseLoserUserValue2 = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('clearingHouseLoserUserValue2:', clearingHouseLoserUserValue2);

		console.log(
			'clearingHouseLoserUser.getLeverage2:',
			clearingHouseLoserUserLeverage2,
			'clearingHouseLoserUserLiqPrice2:',
			clearingHouseLoserUserLiqPrice2,
			'bank0Value2:',
			bank0Value2.toString(),
			'clearingHouseLoserUserValue2:',
			clearingHouseLoserUserValue2.toString()
		);

		const solAmount = new BN(1 * 10 ** 9);
		[
			liquidatorClearingHouse,
			liquidatorClearingHouseWSOLAccount,
			liquidatorClearingHouseWUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			chProgram,
			solAmount,
			usdcAmount.mul(new BN(10)),
			[new BN(0)],
			[new BN(0), new BN(1)],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			]
		);
		await liquidatorClearingHouse.subscribe();

		const bankIndex = new BN(1);
		await liquidatorClearingHouse.deposit(
			solAmount,
			bankIndex,
			liquidatorClearingHouseWSOLAccount
		);
		await liquidatorClearingHouse.deposit(
			usdcAmount.mul(new BN(10)),
			new BN(0),
			liquidatorClearingHouseWUSDCAccount
		);

		const market0 = clearingHouse.getPerpMarketAccount(new BN(0));
		const winnerUser = clearingHouse.getUserAccount();
		const loserUser = clearingHouseLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		// TODO: quoteAssetAmountShort!= sum of users
		assert(
			market0.amm.quoteAssetAmountShort.eq(
				winnerUser.perpPositions[0].quoteAssetAmount
			)
		);

		assert(
			market0.amm.quoteAssetAmountLong.eq(
				loserUser.perpPositions[0].quoteAssetAmount
			)
		);
	});

	it('put market in reduce only mode', async () => {
		const marketIndex = new BN(0);
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 3);

		// await clearingHouse.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(43.1337 * MARK_PRICE_PRECISION.toNumber())
		// );

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await clearingHouse.updateMarketExpiry(marketIndex, expiryTs);
		await sleep(1000);
		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'reduceOnly'));
		console.log(
			'market.expiryTs == ',
			market.expiryTs.toString(),
			'(',
			expiryTs.toString(),
			')'
		);
		assert(market.expiryTs.eq(expiryTs));

		console.log('totalExchangeFee:', market.amm.totalExchangeFee.toString());
		console.log('totalFee:', market.amm.totalFee.toString());
		console.log('totalMMFee:', market.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		// should fail
		// try {
		// 	await clearingHouseLoser.openPosition(
		// 		PositionDirection.LONG,
		// 		new BN(10000000),
		// 		new BN(0),
		// 		new BN(0)
		// 	);
		// 	assert(false);
		// } catch (e) {
		// 	console.log(e);

		// 	if (!e.toString().search('AnchorError occurred')) {
		// 		assert(false);
		// 	}
		// 	console.log('risk increase trade failed');
		// }

		// should succeed
		// await clearingHouseLoser.openPosition(
		// 	PositionDirection.SHORT,
		// 	new BN(10000000),
		// 	new BN(0),
		// 	new BN(0)
		// );
	});

	it('put market in settlement mode', async () => {
		const marketIndex = new BN(0);
		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log('market0.status:', market0.status);
		while (market0.expiryTs.gte(new BN(now))) {
			console.log(market0.expiryTs.toString(), '>', now);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// try {
		const txSig = await clearingHouse.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log(
			'market.settlementPrice:',
			convertToNumber(market.settlementPrice)
		);

		const curPrice = (await getFeedData(anchor.workspace.Pyth, solOracle))
			.price;
		console.log('new oracle price:', curPrice);

		assert(market.settlementPrice.gt(ZERO));
		assert(market.settlementPrice.eq(new BN(404999999999)));
	});

	it('liq and settle expired market position', async () => {
		const marketIndex = new BN(0);
		const loserUser0 = clearingHouseLoser.getUserAccount();
		assert(loserUser0.perpPositions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(new BN(0)));
		// console.log(loserUser0.perpPositions[0]);

		const liquidatorClearingHouseUser = new ClearingHouseUser({
			clearingHouse: liquidatorClearingHouse,
			userAccountPublicKey:
				await liquidatorClearingHouse.getUserAccountPublicKey(),
		});
		await liquidatorClearingHouseUser.subscribe();

		const liquidatorClearingHouseValue = convertToNumber(
			liquidatorClearingHouseUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'liquidatorClearingHouseValue:',
			liquidatorClearingHouseValue.toString()
		);

		const txSigLiq = await liquidatorClearingHouse.liquidatePerp(
			await clearingHouseLoser.getUserAccountPublicKey(),
			clearingHouseLoser.getUserAccount(),
			marketIndex,
			BASE_PRECISION.mul(new BN(290))
		);

		console.log(txSigLiq);

		const liquidatorClearingHouseValueAfter = convertToNumber(
			liquidatorClearingHouseUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'liquidatorClearingHouseValueAfter:',
			liquidatorClearingHouseValueAfter.toString()
		);

		console.log('settle position clearingHouseLoser');
		const txSig = await clearingHouseLoser.settleExpiredPosition(
			await clearingHouseLoser.getUserAccountPublicKey(),
			clearingHouseLoser.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		console.log('settle pnl clearingHouseLoser');

		try {
			await clearingHouse.settlePNL(
				await clearingHouse.getUserAccountPublicKey(),
				clearingHouse.getUserAccount(),
				marketIndex
			);
		} catch (e) {
			// if (!e.toString().search('AnchorError occurred')) {
			// 	assert(false);
			// }
			console.log('Cannot settle pnl under current market status');
		}

		// const settleRecord = eventSubscriber.getEventsArray('SettlePnlRecord')[0];
		// console.log(settleRecord);

		await clearingHouseLoser.fetchAccounts();
		const loserUser = clearingHouseLoser.getUserAccount();
		// console.log(loserUser.perpPositions[0]);
		assert(loserUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		assert(loserUser.perpPositions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = clearingHouse.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin0 = new BN(1415296436 - 11090);
		const finalPnlResultMax0 = new BN(1415296436 + 111090);

		console.log(marketAfter0.pnlPool.balance.toString());
		assert(marketAfter0.pnlPool.balance.gt(finalPnlResultMin0));
		assert(marketAfter0.pnlPool.balance.lt(finalPnlResultMax0));

		// const ammPnlResult = new BN(0);
		console.log('feePool:', marketAfter0.amm.feePool.balance.toString());
		console.log(
			'totalExchangeFee:',
			marketAfter0.amm.totalExchangeFee.toString()
		);
		assert(marketAfter0.amm.feePool.balance.eq(new BN(4356250)));
		await liquidatorClearingHouseUser.unsubscribe();
	});
});