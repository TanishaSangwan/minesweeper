// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MinesweeperTournament} from "../src/MinesweeperTournament.sol";

/// @dev Local/testing deploy path (anvil, or a throwaway PRIVATE_KEY on testnet). The real
///      deploy for this project should go through the Alchemy Agent Wallet session
///      (monskills `wallet` skill), which uses CREATE2 via the canonical CreateX factory
///      instead of a raw private key — see contracts/README.md.
contract Deploy is Script {
    function run() external returns (MinesweeperTournament) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        MinesweeperTournament tournament = new MinesweeperTournament(deployer);
        vm.stopBroadcast();

        console.log("MinesweeperTournament deployed to:", address(tournament));
        return tournament;
    }
}
