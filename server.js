import express from "express";
import bodyParser from "body-parser";
import AWS from "aws-sdk";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import cors from "cors";



dotenv.config();
const app = express();
app.use(bodyParser.json());
app.use(cors());

AWS.config.update({ region: process.env.AWS_REGION });

// Initialize services
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const cognito = new AWS.CognitoIdentityServiceProvider();



// ========== 1️⃣ SIGNUP / LOGIN WITH COGNITO ==========
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  try {
    await cognito
      .signUp({
        ClientId: process.env.CLIENT_ID,
        Username: email,
        Password: password,
      })
      .promise();
    res.json({ message: "Signup successful! Check your email for verification." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get("/confirm", async (req, res) => {
  const { username, code } = req.query;
  try {
    await cognito.adminConfirmSignUp({
      UserPoolId: process.env.USER_POOL_ID,
      Username: username,
    }).promise();
    res.redirect("/confirm.html");
  } catch (err) {
    res.status(400).send("Error confirming user: " + err.message);
  }
});

app.post("/login", async (req, res) => {
  const { email, username, password } = req.body;

  // Prefer username if provided; fallback to email
  const loginId = username || email;

  if (!loginId || !password) {
    return res.status(400).json({ error: "Username/email and password are required" });
  }

  try {
    const data = await cognito
      .initiateAuth({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: process.env.CLIENT_ID, // from your App client (not pool)
        AuthParameters: {
          USERNAME: loginId,
          PASSWORD: password,
        },
      })
      .promise();

    res.json({
      message: "Login successful",
      token: data.AuthenticationResult.IdToken,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// Middleware to verify JWT
function verifyJWT(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = jwt.decode(token);
    req.user = decoded;
    next();
  } catch {
    res.status(403).json({ error: "Invalid token" });
  }
}

// ========== 2️⃣ GROUP MANAGEMENT (DynamoDB) ==========
app.post("/createGroup", verifyJWT, async (req, res) => {
  const { GroupID } = req.body;
  const userEmail = req.user.email;

  try {
    await dynamoDB
      .put({
        TableName: "Groups",
        Item: {
          GroupID,
          Members: [userEmail],
          Roles: { [userEmail]: "admin" },
        },
      })
      .promise();
    res.json({ message: "Group created successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/joinGroup", verifyJWT, async (req, res) => {
  const { GroupID } = req.body;
  const userEmail = req.user.email;

  try {
    const group = await dynamoDB
      .get({ TableName: "Groups", Key: { GroupID } })
      .promise();

    if (!group.Item) return res.status(404).json({ error: "Group not found" });

    group.Item.Members.push(userEmail);
    await dynamoDB
      .put({ TableName: "Groups", Item: group.Item })
      .promise();

    res.json({ message: "Joined group successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 3️⃣ FILE UPLOAD / ACCESS (S3) ==========
app.post("/generateUploadURL", verifyJWT, async (req, res) => {
  const { GroupID, filename } = req.body;
  const userEmail = req.user.email;

  const key = `${GroupID}/${filename}`;
  const params = {
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Expires: 60 * 5, // 5 minutes
    ContentType: "application/octet-stream",
  };

  try {
    const uploadURL = await s3.getSignedUrlPromise("putObject", params);
    res.json({ uploadURL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/generateDownloadURL", verifyJWT, async (req, res) => {
  const { GroupID, filename } = req.query;
  const key = `${GroupID}/${filename}`;
  const params = { Bucket: process.env.S3_BUCKET, Key: key, Expires: 60 * 5 };

  try {
    const downloadURL = await s3.getSignedUrlPromise("getObject", params);
    res.json({ downloadURL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 4️⃣ TRIGGER LAMBDA (Optional for Alerts) ==========
const lambda = new AWS.Lambda();

app.post("/triggerLambda", async (req, res) => {
  try {
    const response = await lambda
      .invoke({
        FunctionName: "notifyOnUpload",
        Payload: JSON.stringify({ message: "Manual trigger test" }),
      })
      .promise();
    res.json({ result: JSON.parse(response.Payload) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Define the API endpoint that the client-side JavaScript will call
app.get('/api/groups', (req, res) => {
  // Send the JSON array of groups
  res.json(studyGroups);
});

// API endpoint to get the logged-in user's name
app.get("/api/user/name", (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Verify and decode the JWT (no need for your own secret — use Cognito’s public key normally)
    // For local testing only — decoding without validation:
    const decoded = jwt.decode(token);

    const name =
      decoded.name ||
      `${decoded.given_name || ""} ${decoded.family_name || ""}`.trim() ||
      decoded.email ||
      "User";

    res.json({ displayName: name });
  } catch (err) {
    res.status(400).json({ error: "Invalid token" });
  }
});

// Middleware to authenticate JWT token from Cognito
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Expecting "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  try {
    // verify token (replace 'your-secret' if you’re using Cognito's JWKS verify later)
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) throw new Error("Invalid token");

    req.user = decoded.payload; // attach user info to request
    next();
  } catch (err) {
    res.status(403).json({ error: "Invalid or expired token." });
  }
}

// This is the new API route to be added to your server.js
app.get('/api/user/groups', authenticateToken, (req, res) => {
  // 1. req.user is available here (containing ID, email, etc., validated by Cognito)
  const userId = req.user.id;

  // 2. CONCEPTUAL LOGIC: Fetch groups from a database (Firestore/SQL/etc.) 
  //    where the current userId is listed as a member.

  // 3. Send the filtered list back to the client
  res.json(userSpecificGroups);
});


app.listen(3000, () => console.log("✅ Server running on http://localhost:3000"));
