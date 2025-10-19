import express from "express";
import bodyParser from "body-parser";
import AWS from "aws-sdk";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(bodyParser.json());

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

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const data = await cognito
      .initiateAuth({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: process.env.CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
      .promise();

    res.json({ token: data.AuthenticationResult.IdToken });
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

app.listen(3000, () => console.log("✅ Server running on http://localhost:3000"));
