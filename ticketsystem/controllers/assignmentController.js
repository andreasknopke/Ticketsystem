const User = require('../models/User'); // Adjust path to actual User model

exports.renderAssignment = async (req, res) => {
  try {
    const bots = await exports.getAssignableBots();
    const collisionMap = {};
    bots.forEach(bot => {
      if (bot.hasCollision) {
        collisionMap[bot._id] = bot.collisionBots;
      }
    });
    res.render('assignment', {
      bots,
      collisionMapJSON: JSON.stringify(collisionMap),
      ticketId: req.params.ticketId // Pass ticket ID for submission
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading assignment page');
  }
};

exports.getAssignableBots = async () => {
  const allBots = await User.find({ role: 'bot' }).lean(); // Adjust role field as needed
  const levelGroups = {};
  allBots.forEach(bot => {
    if (!bot.codingLevel) return; // Only consider bots with a coding level
    if (!levelGroups[bot.codingLevel]) {
      levelGroups[bot.codingLevel] = [];
    }
    levelGroups[bot.codingLevel].push(bot);
  });
  return allBots.map(bot => {
    const level = bot.codingLevel;
    const group = levelGroups[level];
    if (group && group.length > 1) {
      bot.hasCollision = true;
      bot.collisionBots = group;
    } else {
      bot.hasCollision = false;
    }
    return bot;
  });
};

exports.submitAssignment = async (req, res) => {
  const { ticketId, userId } = req.body;
  // Assignment logic placeholder – adapt to actual project requirements
  // e.g., Ticket.findByIdAndUpdate(ticketId, { assignedBot: userId });
  res.redirect(`/tickets/${ticketId}`);
};
