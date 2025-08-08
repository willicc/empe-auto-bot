require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningStargateClient, GasPrice, StargateClient, QueryClient } = require("@cosmjs/stargate");
const { coins } = require("@cosmjs/amino");
const chalk = require("chalk");
const { Tendermint34Client } = require("@cosmjs/tendermint-rpc");
const { setupDistributionExtension, setupStakingExtension } = require("@cosmjs/stargate/build/modules");
const { bech32 } = require("bech32");


const RPC_ENDPOINT = "https://rpc-testnet.empe.io";
const CHAIN_ID = "empe-testnet-2";
const PREFIX = "empe";
const DENOM = "uempe"; 
const EXPLORER_URL = "https://explorer-testnet.empe.io/accounts";


const MNEMONIC = process.env.MNEMONIC;
const MIN_AMOUNT = parseInt(process.env.MIN_AMOUNT || "2");
const MAX_AMOUNT = parseInt(process.env.MAX_AMOUNT || "129");
const DELAY_MS = parseInt(process.env.DELAY_MS || "5000");
const GAS_MULTIPLIER = parseFloat(process.env.GAS_MULTIPLIER || "1.5");
const MAX_CLAIM_PER_TX = parseInt(process.env.MAX_CLAIM_PER_TX || "100");


if (!MNEMONIC) throw new Error("❌ MNEMONIC harus diatur di file .env");
if (MIN_AMOUNT < 1) throw new Error("❌ MIN_AMOUNT minimal 1");
if (MAX_AMOUNT <= MIN_AMOUNT) throw new Error("❌ MAX_AMOUNT harus lebih besar dari MIN_AMOUNT");


function clearTerminal() {
    process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
}

function createProgressBar(current, total, length = 40) {
    const percent = Math.min(100, Math.max(0, (current / total) * 100));
    const filled = Math.round(length * (percent / 100));
    const empty = length - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent.toFixed(1)}%`;
}

async function showRunningAnimation(seconds) {
    const frames = [
        "🚶‍♂️    ",
        " 🚶‍♂️   ",
        "  🚶‍♂️  ",
        "   🚶‍♂️ ",
        "    🚶‍♂️",
        "   🏃‍♂️ ",
        "  🏃‍♂️  ",
        " 🏃‍♂️   ",
        "🏃‍♂️    ",
        " 🏃‍♂️   ",
        "  🏃‍♂️  ",
        "   🏃‍♂️ ",
    ];
    
    const start = Date.now();
    const duration = seconds * 1000;
    let frameIndex = 0;
    
    while (Date.now() - start < duration) {
        process.stdout.write(`\r${chalk.yellow(frames[frameIndex])} ${chalk.cyan(`Menunggu ${seconds} detik...`)}`);
        frameIndex = (frameIndex + 1) % frames.length;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    process.stdout.write('\r\x1B[K'); 
}

function validateAddress(address, expectedPrefix) {
    try {
        const decoded = bech32.decode(address);
        return decoded.prefix === expectedPrefix;
    } catch (error) {
        return false;
    }
}

async function getDelegations(address) {
    try {
        const tmClient = await Tendermint34Client.connect(RPC_ENDPOINT);
        
        const queryClient = QueryClient.withExtensions(tmClient, setupStakingExtension);
        
        const response = await queryClient.staking.delegatorDelegations(address);
        
        return response.delegationResponses.map(d => ({
            validatorAddress: d.delegation.validatorAddress,
            amount: d.balance.amount
        }));
    } catch (error) {
        console.error(chalk.red(`❌ Gagal mengambil delegasi: ${error.message}`));
        return [];
    }
}

async function getRewards(address) {
    try {
        const tmClient = await Tendermint34Client.connect(RPC_ENDPOINT);
        
        const queryClient = QueryClient.withExtensions(tmClient, setupDistributionExtension);
        
        const response = await queryClient.distribution.delegationTotalRewards(address);
        
        return {
            rewards: response.rewards.map(r => ({
                validatorAddress: r.validatorAddress,
                reward: r.reward.find(c => c.denom === DENOM)?.amount || "0"
            })),
            total: response.total.find(c => c.denom === DENOM)?.amount || "0"
        };
    } catch (error) {
        console.error(chalk.red(`❌ Gagal mengambil reward: ${error.message}`));
        return { rewards: [], total: "0" };
    }
}

async function getAccountBalance(address) {
    try {
        const client = await StargateClient.connect(RPC_ENDPOINT);
        
        const balance = await client.getBalance(address, DENOM);
        return balance;
    } catch (error) {
        console.error(chalk.red(`❌ Gagal mengambil saldo: ${error.message}`));
        return { amount: "0", denom: DENOM };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function estimateGas(client, fromAddress, messages) {
    try {
        const simulateResult = await client.simulate(fromAddress, messages, "");
        const gasUsed = Math.ceil(simulateResult);
        const gasLimit = Math.ceil(gasUsed * GAS_MULTIPLIER);
        const feeAmount = Math.ceil(gasLimit * 0.025); 
        
        return { gasUsed, gasLimit, feeAmount };
    } catch (error) {
        console.log(chalk.yellow("⚠️ Gagal simulasi gas, menggunakan nilai default"));
        
        let defaultGas;
        if (messages[0] && messages[0].typeUrl) {
            if (messages[0].typeUrl.includes("MsgSend")) {
                defaultGas = 70000;
            } else if (messages[0].typeUrl.includes("MsgDelegate")) {
                defaultGas = 140000;
            } else if (messages[0].typeUrl.includes("MsgWithdrawDelegatorReward")) {
                defaultGas = 60000 * messages.length;
            } else {
                defaultGas = 100000;
            }
        } else {
            defaultGas = 100000;
        }
        
        const gasLimit = Math.ceil(defaultGas * GAS_MULTIPLIER);
        const feeAmount = Math.ceil(gasLimit * 0.025);
        
        return {
            gasUsed: defaultGas,
            gasLimit,
            feeAmount
        };
    }
}


async function claimRewards(client, account, validatorAddresses, rl) {
    try {
        console.log(chalk.bold(`\n🚀 Mengklaim reward dari ${validatorAddresses.length} validator`));
        
        const messages = validatorAddresses.map(validator => ({
            typeUrl: "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
            value: {
                delegatorAddress: account.address,
                validatorAddress: validator,
            },
        }));
        
        try {
            console.log(`\n📤 Mengklaim reward dari ${validatorAddresses.length} validator sekaligus`);
            
            const gasEstimation = await estimateGas(client, account.address, messages);
            const fee = {
                amount: coins(gasEstimation.feeAmount.toString(), DENOM), 
                gas: gasEstimation.gasLimit.toString(),
            };
            
            console.log(`⛽ Gas: ${fee.gas} | Biaya: ${gasEstimation.feeAmount} ${DENOM}`);
            
            const result = await client.signAndBroadcast(
                account.address,
                messages,
                fee,
                "" 
            );
            
            if (result.code === 0) {
                console.log(chalk.green(`✅ Berhasil! Hash: ${result.transactionHash}`));
                console.log(chalk.blue(`🔗 Explorer: https://explorer-testnet.empe.io/transactions/${result.transactionHash}`));
                
                let totalClaimed = 0;
                if (result.events) {
                    result.events.forEach(event => {
                        if (event.type === "withdraw_rewards") {
                            const amountAttr = event.attributes.find(attr => attr.key === "amount");
                            const validatorAttr = event.attributes.find(attr => attr.key === "validator");
                            if (amountAttr && validatorAttr) {
                                const amount = amountAttr.value.replace(DENOM, "");
                                totalClaimed += parseInt(amount);
                                console.log(`🎁 ${validatorAttr.value}: ${chalk.green(parseInt(amount) / 1e6)} EMPE`);
                            }
                        }
                    });
                }
                
                if (totalClaimed > 0) {
                    console.log(chalk.bold(`\n💰 Total Diklaim: ${chalk.green(totalClaimed / 1e6)} EMPE`));
                }
            } else {
                console.log(chalk.red(`❌ Gagal! Kode: ${result.code}`));
                console.log(chalk.red(`Log: ${result.rawLog}`));
            }
        } catch (error) {
            console.log(chalk.red(`⛔ Error: ${error.message}`));
            if (error.message.includes("insufficient fees")) {
                console.log(chalk.yellow("💡 Tips: Tambah pengali gas di file .env (GAS_MULTIPLIER=2.0)"));
            }
        }

    } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
    } finally {
        rl.close();
    }
}

function readRecipients(filename, isValidator = false) {
    try {
        if (!fs.existsSync(filename)) {
            throw new Error(`File ${filename} tidak ditemukan`);
        }
        
        const data = fs.readFileSync(filename, "utf8");
        const recipients = data
            .split('\n')
            .map(addr => addr.trim())
            .filter(addr => {
                if (!addr) return false;
                return true;
            });
            
        console.log(chalk.yellow(`📁 Ditemukan ${recipients.length} alamat di ${filename}`));
        return recipients;
    } catch (error) {
        throw new Error(`Gagal membaca ${filename}: ${error.message}`);
    }
}

function getRandomAmount() {
    return Math.floor(Math.random() * (MAX_AMOUNT - MIN_AMOUNT + 1)) + MIN_AMOUNT;
}


async function main() {
    clearTerminal();
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log(chalk.bold.blue("\n🤖 Empe Testnet Automation Bot | bactiar291"));
    console.log(chalk.gray("=======================================================\n"));

    console.log(chalk.bold("Pilih mode operasi:"));
    console.log("1. 📤 Auto Send Tokens");
    console.log("2. 🏦 Auto Delegate Tokens");
    console.log("3. 💰 Auto Klaim Reward");
    console.log("4. 🚪 Keluar\n");
    
    const mode = await new Promise(resolve => {
        rl.question("Masukkan pilihan (1/2/3/4): ", answer => resolve(answer.trim()));
    });
    
    if (!["1", "2", "3", "4"].includes(mode)) {
        console.log(chalk.red("❌ Pilihan tidak valid"));
        rl.close();
        process.exit(1);
    }

    if (mode === "4") {
        rl.close();
        process.exit(0);
    }

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
        prefix: PREFIX,
    });
    
    const [account] = await wallet.getAccounts();
    
    const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet, {
        gasPrice: GasPrice.fromString("0.025uempe"),
    });

    if (mode === "3") {
        try {
            console.log(chalk.bold("\n🔍 Mencari delegasi dan reward..."));
            
            const delegations = await getDelegations(account.address);
            const rewards = await getRewards(account.address);
            
            if (delegations.length === 0) {
                console.log(chalk.yellow("⚠️ Tidak ada delegasi aktif"));
                rl.close();
                process.exit(0);
            }
            
            console.log(chalk.green(`✔️ Ditemukan ${delegations.length} delegasi aktif`));
            
            const validatorsWithRewards = rewards.rewards
                .filter(r => parseInt(r.reward) > 0)
                .map(r => r.validatorAddress);
            
            if (validatorsWithRewards.length === 0) {
                console.log(chalk.yellow("⚠️ Tidak ada reward yang bisa diklaim"));
                rl.close();
                process.exit(0);
            }
            
            const totalClaimable = rewards.rewards.reduce(
                (sum, r) => sum + parseInt(r.reward), 0
            );
            
            console.log(chalk.bold(`\n💰 Total Reward Diklaim: ${chalk.green(totalClaimable / 1e6)} EMPE`));
            console.log(chalk.gray("-------------------------------------------"));
            
            rewards.rewards.forEach(r => {
                if (parseInt(r.reward) > 0) {
                    console.log(`⚡ Validator: ${chalk.cyan(r.validatorAddress)} | Reward: ${chalk.green(parseInt(r.reward) / 1e6)} EMPE`);
                }
            });
            
            console.log(chalk.gray("-------------------------------------------\n"));
            
            const confirm = await new Promise(resolve => {
                rl.question("Apakah Anda yakin ingin mengklaim semua reward? (y/n): ", answer => resolve(answer.trim().toLowerCase()));
            });
            
            if (confirm !== "y") {
                console.log(chalk.yellow("\nOperasi dibatalkan"));
                rl.close();
                process.exit(0);
            }
            
            await claimRewards(client, account, validatorsWithRewards, rl);
            
        } catch (error) {
            console.log(chalk.red(`❌ Error: ${error.message}`));
            rl.close();
            process.exit(1);
        }
    }

    if (mode === "1" || mode === "2") {
        const file = mode === "1" ? "addrs.txt" : "validators.txt";
        let recipients;
        
        try {
            recipients = readRecipients(file, mode === "2");
        } catch (error) {
            console.log(chalk.red(`❌ ${error.message}`));
            rl.close();
            process.exit(1);
        }
        
        if (recipients.length === 0) {
            console.log(chalk.red(`❌ Tidak ada alamat valid di ${file}`));
            rl.close();
            process.exit(1);
        }

        const balance = await getAccountBalance(account.address);
        console.log(chalk.bold("\n📊 Informasi Akun:"));
        console.log(chalk.gray("-------------------------------------------"));
        console.log(`🏷️  Alamat: ${chalk.cyan(account.address)}`);
        console.log(`💰 Saldo: ${chalk.green((parseInt(balance.amount) / 1e6))} EMPE`);
        console.log(chalk.gray(`🔗 Explorer: ${EXPLORER_URL}/${account.address}`));
        console.log(chalk.gray("-------------------------------------------\n"));

        console.log(chalk.bold("🚀 Memulai operasi:"));
        console.log(chalk.gray("-------------------------------------------"));
        console.log(`🔧 Mode: ${chalk.cyan(mode === "1" ? "Auto Send" : "Auto Delegate")}`);
        console.log(`📁 File: ${chalk.yellow(file)} (${recipients.length} alamat)`);
        console.log(`🎲 Jumlah random: ${chalk.green(MIN_AMOUNT)}-${chalk.green(MAX_AMOUNT)} ${DENOM}`);
        console.log(`⏱️  Delay: ${chalk.yellow(DELAY_MS/1000)} detik/transaksi`);
        console.log(`⛽ Gas Multiplier: ${chalk.yellow(GAS_MULTIPLIER)}x`);
        console.log(chalk.gray("-------------------------------------------\n"));

        const confirm = await new Promise(resolve => {
            rl.question("Apakah Anda yakin ingin melanjutkan? (y/n): ", answer => resolve(answer.trim().toLowerCase()));
        });
        
        if (confirm !== "y") {
            console.log(chalk.yellow("\nOperasi dibatalkan"));
            rl.close();
            process.exit(0);
        }

        const estimatedTime = ((recipients.length * DELAY_MS) / 1000 / 60).toFixed(1);
        console.log(chalk.bold(`\n⏳ Estimasi waktu selesai: ${estimatedTime} menit`));
        
        let successCount = 0;
        const startTime = Date.now();
        
        for (let i = 0; i < recipients.length; i++) {
            clearTerminal();
            
            console.log(chalk.bold.blue("\n🤖 Empe Testnet Automation Bot | bactiar291"));
            console.log(chalk.gray("=======================================================\n"));
            
            const progressBar = createProgressBar(i, recipients.length);
            console.log(chalk.bold(`📈 Progress: ${i}/${recipients.length}`));
            console.log(progressBar);
            
            console.log(`\n🔧 Mode: ${chalk.cyan(mode === "1" ? "Auto Send" : "Auto Delegate")}`);
            console.log(`⏱️  Estimasi waktu tersisa: ${((recipients.length - i) * DELAY_MS / 1000 / 60).toFixed(1)} menit`);
            console.log(`✅ Berhasil: ${chalk.green(successCount)}`);
            console.log(`❌ Gagal: ${chalk.red(i - successCount)}`);
            
            const recipient = recipients[i];
            const amount = getRandomAmount();
            
            try {
                console.log(`\n📤 [${i+1}/${recipients.length}] ${mode === "1" ? "Mengirim" : "Mendelegasikan"} ${chalk.bold(amount)} ${DENOM} ke ${chalk.cyan(recipient)}`);
                
                let messages;
                if (mode === "1") {
                    messages = [
                        {
                            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
                            value: {
                                fromAddress: account.address,
                                toAddress: recipient,
                                amount: coins(amount, DENOM),
                            },
                        }
                    ];
                } else {
                    messages = [
                        {
                            typeUrl: "/cosmos.staking.v1beta1.MsgDelegate",
                            value: {
                                delegatorAddress: account.address,
                                validatorAddress: recipient,
                                amount: { denom: DENOM, amount: amount.toString() },
                            },
                        }
                    ];
                }

                const gasEstimation = await estimateGas(client, account.address, messages);
                const fee = {
                    amount: coins(gasEstimation.feeAmount, DENOM),
                    gas: gasEstimation.gasLimit.toString(),
                };
                
                console.log(`⛽ Gas: ${fee.gas} | Fee: ${gasEstimation.feeAmount} ${DENOM}`);
                
                const result = await client.signAndBroadcast(
                    account.address,
                    messages,
                    fee,
                    "" 
                );
                
                if (result.code === 0) {
                    successCount++;
                    console.log(chalk.green(`✅ Berhasil! Hash: ${result.transactionHash}`));
                    console.log(chalk.blue(`🔗 Explorer: https://explorer-testnet.empe.io/transactions/${result.transactionHash}`));
                    console.log(`📊 Gas Used: ${result.gasUsed} / ${result.gasWanted}`);
                } else {
                    console.log(chalk.red(`❌ Gagal! Code: ${result.code}`));
                    console.log(chalk.red(`Log: ${result.rawLog}`));
                }
            } catch (error) {
                console.log(chalk.red(`⛔ Error: ${error.message}`));
            }

            if (i < recipients.length - 1) {
                console.log();
                await showRunningAnimation(DELAY_MS / 1000);
            }
        }

        const endTime = Date.now();
        const totalTime = ((endTime - startTime) / 1000 / 60).toFixed(1);
        
        clearTerminal();
        console.log(chalk.bold.green("\n✨ Semua transaksi selesai diproses!"));
        console.log(chalk.gray("==========================================="));
        console.log(`🔢 Total transaksi: ${recipients.length}`);
        console.log(`✅ Berhasil: ${chalk.green(successCount)}`);
        console.log(`❌ Gagal: ${chalk.red(recipients.length - successCount)}`);
        console.log(`⏱️  Total waktu: ${totalTime} menit`);
        console.log(chalk.blue(`🔗 Explorer: ${EXPLORER_URL}/${account.address}`));
        console.log(chalk.gray("===========================================\n"));
        
        rl.close();
    }
}


main().catch((error) => {
    console.error(chalk.red("❌ Error Kritis:"), error.message);
    process.exit(1);
});
