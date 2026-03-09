// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract ExchangeVault {
    IERC20 public token;
    address public owner;

    event Deposited(bytes32 indexed userId, address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(address tokenAddress) {
        token = IERC20(tokenAddress);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function deposit(bytes32 userId, uint256 amount) external {
        require(amount > 0, "amount=0");

        bool ok = token.transferFrom(msg.sender, address(this), amount);
        require(ok, "transferFrom failed");

        emit Deposited(userId, msg.sender, amount);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad address");
        require(amount > 0, "amount=0");

        bool ok = token.transfer(to, amount);
        require(ok, "transfer failed");

        emit Withdrawn(to, amount);
    }
}