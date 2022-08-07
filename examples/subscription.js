const Dante = require("../dante");

const dante = new Dante();

//Turn on debug mode so we can see what's being sent and received.
dante.debug = true;

// Make a subscription - provide the IP address of the device and the channel numbers to be the reciever.
// Provide the device name and the channel name of the transmitter.
dante.makeSubscription("10.32.61.13", 1, "Radio One (Left)", "bcn-pw-dantepc001");

// Remove a subscription - provide the IP address of the device and the channel number. Removes this subscription.
dante.clearSubscription("10.32.61.13", 2);
