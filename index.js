const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);


const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());


const serviceAccount = require("./zip-shift-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ry0n7jv.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("parcelDB");
        const usersCollection = db.collection('users');
        const parcelCollection = db.collection("parcels");
        const paymentsCollection = db.collection("payments");
        const ridersCollection = db.collection('riders');

        // custom middleware
        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({ message: 'unauthorized access' })
            }
            const token = authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).send({ message: 'unauthorized access' })
            }

            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            }
            catch (error) {
                return res.status(403).send({ message: 'forbidden access' })
            }
        }

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email }
            const user = await usersCollection.findOne(query);
            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }

        // GET /users/search?email=someone@example.com
        app.get("/users/search", async (req, res) => {
            const email = req.query.email;
            if (!email) return res.status(400).send({ error: "Email is required" });

            const regex = new RegExp(email, "i");

            try {
                const user = await usersCollection.find({ email: { $regex: regex } }).limit(10).toArray();

                res.send(user);
            } catch (error) {
                console.error('Error searching users', error);
                res.status(500).send({ error: "User not found" });
            }
        });

        app.patch("/users/:id/role", verifyFBToken, verifyAdmin, async (req, res) => {
            const { id } = req.params;
            const { role } = req.body;
            if (!['admin', 'user'].includes(role)) {
                return res.status(400).send({ message: 'Invalid role' });
            }

            try {
                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { role } }
                );
                res.send({ message: `User role updated to ${role}`, result });
            } catch (error) {
                console.error('Error updating user role', error);
                res.status(500).send({ message: 'Failed to update user role' });
            }

        });


        app.get('/users/:email/role', async (req, res) => {
            try {
                const email = req.params.email;

                if (!email) {
                    return res.status(400).send({ message: 'Email is required' });
                }

                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).send({ message: 'User not found' });
                }

                res.send({ role: user.role || 'user' });
            } catch (error) {
                console.error('Error getting user role:', error);
                res.status(500).send({ message: 'Failed to get role' });
            }
        })

        app.post('/users', async (req, res) => {
            const email = req.body.email;
            const userExists = await usersCollection.findOne({ email });
            if (userExists) {
                return res.status(200).send({ message: 'User already exists', inserted: false })
            }
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        })


        app.get("/parcels", async (req, res) => {
            const parcels = await parcelCollection.find({}).toArray();
            res.send(parcels);
        });

        app.get('/parcels', verifyFBToken, async (req, res) => {
            try {
                const { email,
                    payment_status, delivery_status
                } = req.query;

                let query = {}
                if (email) {
                    query = { created_by: email }
                }

                if (
                    payment_status) {
                    query.payment_status = payment_status
                }

                if (
                    delivery_status) {
                    query.delivery_status = delivery_status
                }

                const options = {
                    sort: { createdAt: -1 },
                }

                const parcels = await parcelCollection.find(query, options).toArray();
                res.send(parcels);

            } catch (error) {
                console.error('Error fetching parcels:', error);
                res.status(500).send({ message: 'Failed to get parcels' })
            }
        })

        app.get('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;

                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });

                if (!parcel) {
                    return res.status(404).send({ message: 'parcel not found' })
                }

                res.send(parcel);
            } catch (error) {
                console.error('Error fetching parcel:', error);
                res.status(500).send({ message: 'Failed to fetch parcel' })
            }
        })

        app.post("/parcels", async (req, res) => {
            try {
                const newParcel = req.body;

                const result = await parcelCollection.insertOne(newParcel);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error inserting parcel:", error);
                res.status(500).send({ message: "Failed to insert parcel" });
            }
        });

        app.post('/create-payment-intent', async (req, res) => {

            const amountInCents = req.body.amountInCents;

            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents,
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.get('/payments', verifyFBToken, async (req, res) => {
            try {
                const userEmail = req.query.email;

                if (req.decoded.email !== userEmail) {
                    return res.status(403).send({ message: 'forbidden access' })
                }


                const query = userEmail ? { email: userEmail } : {};

                const options = { sort: { paid_At: -1 } };

                const payments = await paymentsCollection.find(query, options).toArray();
                res.send(payments);
            } catch (error) {
                console.error('Error fetching payment history:', error),
                    res.status(500).send({ message: 'Failed to get payments' })
            }
        })

        app.post('/payments', async (req, res) => {
            try {
                const { parcelId, email, amount, paymentMethod, transactionId } = req.body;

                const updatedResult = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            payment_status: "paid"
                        }
                    }
                )

                if (updatedResult.matchedCount === 0) {
                    return res.status(404).send({ message: 'Parcel not found or already paid' });
                }

                const paymentDoc = {
                    parcelId,
                    email,
                    amount,
                    paymentMethod,
                    transactionId,
                    paid_at_string: new Date().toISOString(),
                    paid_At: new Date(),
                }

                const paymentResult = await paymentsCollection.insertOne(paymentDoc);

                res.status(201).send({
                    message: 'Payment recorded and parcel marked as paid',
                    insertedId: paymentResult.insertedId
                });
            } catch (error) {
                console.error('Payment processing failed', error)
            }
        })

        app.post('/riders', async (req, res) => {
            const rider = req.body;
            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        })

        app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const pendingRiders = await ridersCollection
                    .find({ status: "pending" })
                    .sort({ submittedAt: -1 }) // Optional: sort by latest
                    .toArray();

                res.send(pendingRiders);
            } catch (error) {
                console.error("Error fetching pending riders:", error);
                res.status(500).send({ message: "Failed to fetch pending riders" });
            }
        });


        // Approve rider
        app.patch('/riders/approve/:id', async (req, res) => {
            const { id } = req.params;
            const { email } = req.body;
            try {
                const result = await ridersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: "approved" } }
                );

                if (result.modifiedCount > 0) {
                    const userQuery = { email };
                    const userUpdatedDoc = {
                        $set: {
                            role: 'rider'
                        }
                    };
                    const roleResult = await usersCollection.updateOne(userQuery, userUpdatedDoc)
                    console.log(roleResult.modifiedCount)
                }
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to approve rider", error });
            }
        });

        // Reject rider
        app.patch('/riders/reject/:id', async (req, res) => {
            const { id } = req.params;
            try {
                const result = await ridersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: "rejected" } }
                );
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to reject rider", error });
            }
        });

        // Get all active riders
        app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
            const riders = await ridersCollection.find({ status: "approved" }).toArray();
            res.send(riders);
        });

        // Deactivate a rider
        app.patch("/riders/deactivate/:id", async (req, res) => {
            const id = req.params.id;
            const result = await ridersCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status: "deactivated" } }
            );
            res.send(result);
        });

        app.patch("/parcels/:id/assign-rider", async (req, res) => {
            const { id } = req.params;
            const { riderId } = req.body;

            if (!riderId) return res.status(400).send({ message: "Rider ID required" });

            try {
                // Update parcel: assign rider and set delivery status
                const parcelUpdateResult = await parcelCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            assignedRider: new ObjectId(riderId),
                            delivery_status: "in-transit",
                        },
                    }
                );

                // Add work_status to rider if not exists
                const riderUpdateResult = await ridersCollection.updateOne(
                    { _id: new ObjectId(riderId) },
                    {
                        $set: {
                            work_status: "in-delivery",
                        },
                    }
                );

                res.send({
                    message: "Rider assigned and statuses updated",
                    parcelUpdateResult,
                    riderUpdateResult,
                });
            } catch (error) {
                console.error("Assignment error:", error);
                res.status(500).send({ message: "Failed to assign rider and update statuses" });
            }
        });



        // GET: /riders/active?district=Narsingdi
        app.get("/riders/available", async (req, res) => {
            const district = req.query.district;

            try {
                const filter = { status: "approved" };
                if (district) {
                    filter.district = district;
                }

                const riders = await ridersCollection.find(filter).toArray();
                res.send(riders);
            } catch (error) {
                console.error("Failed to fetch active riders", error);
                res.status(500).send({ message: "Error fetching riders" });
            }
        });



        app.delete('/parcels/:id', async (req, res) => {
            const { id } = req.params;

            try {
                const result = await parcelCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(404).send({ message: 'Parcel not found or already deleted' });
                }

                res.send(result);
            } catch (error) {
                console.error('Delete error:', error);
                res.status(500).send({ message: 'Failed to delete parcel' });
            }
        });


        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get("/", (req, res) => {
    res.send("Welcome to the Zap Shift Server!");
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});